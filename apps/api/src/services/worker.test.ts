import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseClient } from '../db.js';
import type { NotificationProvider } from './email.js';
import type { EmergencyAlertProvider } from './voice-feedback.js';
import { runDeadlineSweep, sendTaskEscalation } from './worker.js';

afterEach(() => vi.unstubAllEnvs());

const now = new Date('2026-09-28T12:00:00.000Z');
const notification = (status: 'SENT' | 'FAILED' = 'SENT'): NotificationProvider => ({
  send: vi.fn().mockResolvedValue({ id: 'notification-1', status })
}) as unknown as NotificationProvider;

function reminderFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'reminder-1', taskId: 'task-1', attemptCount: 0, status: 'PENDING', scheduledAt: new Date(now.getTime() - 60_000),
    task: {
      id: 'task-1', incidentId: 'incident-1', title: 'Inspect pump', status: 'OPEN', deadline: new Date(now.getTime() + 30 * 60_000), assigneeId: 'employee-1',
      incident: { id: 'incident-1', incidentNumber: 'INC-1', title: 'Pump noise', status: 'OPEN', isEmergency: false },
      assignee: { id: 'employee-1', name: 'Worker', email: 'worker@example.test' }
    },
    ...overrides
  };
}

function fakeDb(overrides: Record<string, unknown> = {}) {
  const tx = {
    reminder: { update: vi.fn().mockResolvedValue({}), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    emergencyEvent: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    closureVerification: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    task: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    incident: { update: vi.fn().mockResolvedValue({}), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    voiceReport: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    escalation: { create: vi.fn().mockResolvedValue({ id: 'escalation-1', level: 1 }) },
    auditLog: { create: vi.fn().mockResolvedValue({}) }
  };
  const db = {
    reminder: { updateMany: vi.fn().mockResolvedValue({ count: 0 }), findMany: vi.fn().mockResolvedValue([]) },
    emergencyEvent: { updateMany: vi.fn().mockResolvedValue({ count: 0 }), findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn() },
    closureVerification: { updateMany: vi.fn().mockResolvedValue({ count: 0 }), findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn() },
    task: { findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn(), updateMany: vi.fn() },
    incident: { update: vi.fn(), updateMany: vi.fn() },
    employee: { findUnique: vi.fn().mockResolvedValue(null) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    voiceReport: { updateMany: vi.fn() },
    escalationRule: { findMany: vi.fn().mockResolvedValue([]) },
    $transaction: vi.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
    ...overrides
  };
  return { db: db as unknown as DatabaseClient, tx, raw: db };
}

describe('Phase 6 workflow automation', () => {
  it('sends a due normal reminder and records delivery audit', async () => {
    const reminder = reminderFixture();
    const { db, tx, raw } = fakeDb();
    raw.reminder.findMany = vi.fn().mockResolvedValue([reminder]);
    raw.reminder.updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const notices = notification();

    const result = await runDeadlineSweep(db, now, { notifications: notices });

    expect(result.remindersSent).toBe(1);
    expect(notices.send).toHaveBeenCalledWith(db, expect.objectContaining({ kind: 'REMINDER', taskId: 'task-1' }));
    expect(tx.reminder.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'reminder-1' }, data: expect.objectContaining({ status: 'SENT', sentAt: now }) }));
    expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'REMINDER_SENT', incidentId: 'incident-1' }) }));
  });

  it('retries a failed reminder once on a later sweep and records both outcomes', async () => {
    let status = 'PENDING';
    let attempts = 0;
    const reminder = reminderFixture();
    const { db, tx, raw } = fakeDb();
    raw.reminder.findMany = vi.fn().mockImplementation(async () => status === 'SENT' ? [] : [{ ...reminder, status, attemptCount: attempts }]);
    raw.reminder.updateMany = vi.fn().mockImplementation(async ({ where, data }: { where: { status?: string | { in: string[] } }; data: { status: string; attemptCount?: { increment: number } } }) => {
      const statusIn = typeof where.status === 'object' && where.status !== null ? where.status.in : [];
      const accepted = where.status === 'PROCESSING' ? false : statusIn.includes(status);
      if (accepted) { status = data.status; attempts += data.attemptCount?.increment ?? 0; return { count: 1 }; }
      return { count: 0 };
    });
    tx.reminder.update = vi.fn().mockImplementation(async ({ data }: { data: { status: string } }) => { status = data.status; return {}; });
    const notices = { send: vi.fn().mockResolvedValueOnce({ id: 'n1', status: 'FAILED' }).mockResolvedValueOnce({ id: 'n2', status: 'SENT' }) } as unknown as NotificationProvider;

    const first = await runDeadlineSweep(db, now, { notifications: notices });
    const second = await runDeadlineSweep(db, new Date(now.getTime() + 60_000), { notifications: notices });

    expect(first.remindersFailed).toBe(1);
    expect(second.remindersSent).toBe(1);
    expect(notices.send).toHaveBeenCalledTimes(2);
    expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'REMINDER_DELIVERY_FAILED' }) }));
    expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'REMINDER_SENT' }) }));
  });

  it('claims a reminder atomically so concurrent sweeps do not notify twice', async () => {
    let status = 'PENDING';
    const reminder = reminderFixture();
    const { db, tx, raw } = fakeDb();
    raw.reminder.findMany = vi.fn().mockResolvedValue([reminder]);
    raw.reminder.updateMany = vi.fn().mockImplementation(async ({ where, data }: { where: { status?: string | { in: string[] } }; data: { status: string } }) => {
      if (where.status === 'PROCESSING') return { count: 0 };
      const statusIn = typeof where.status === 'object' && where.status !== null ? where.status.in : [];
      if (statusIn.includes(status)) { status = data.status; return { count: 1 }; }
      return { count: 0 };
    });
    const notices = notification();

    const result = await Promise.all([runDeadlineSweep(db, now, { notifications: notices }), runDeadlineSweep(db, now, { notifications: notices })]);

    expect(result.reduce((sum, item) => sum + item.remindersSent, 0)).toBe(1);
    expect(notices.send).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it('moves an overdue task and its incident through the configured state transition and audits it', async () => {
    const task = {
      id: 'task-1', incidentId: 'incident-1', status: 'OPEN', deadline: new Date(now.getTime() - 1_000),
      incident: { id: 'incident-1', status: 'OPEN', isEmergency: false }
    };
    const { db, tx, raw } = fakeDb();
    raw.task.findMany = vi.fn().mockImplementation(async ({ where }: { where: { status: string | { in?: string[] } } }) =>
      where.status === 'OVERDUE' ? [] : [task]);

    const result = await runDeadlineSweep(db, now, { notifications: notification() });

    expect(result.tasksOverdue).toBe(1);
    expect(tx.task.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: 'task-1', status: { in: ['OPEN', 'IN_PROGRESS'] } }), data: { status: 'OVERDUE' } }));
    expect(tx.incident.updateMany).toHaveBeenCalledWith({ where: { id: 'incident-1', status: 'OPEN' }, data: { status: 'OVERDUE' } });
    expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'TASK_OVERDUE' }) }));
  });

  it('does not escalate an overdue task if no matching escalation policy exists', async () => {
    const task = {
      id: 'task-1', incidentId: 'incident-1', status: 'OVERDUE', deadline: new Date(now.getTime() - 60_000), escalations: [],
      incident: { id: 'incident-1', status: 'OVERDUE', isEmergency: false, responsibleDepartment: 'Maintenance', priority: 'HIGH' }
    };
    const { db, raw } = fakeDb();
    raw.task.findMany = vi.fn().mockImplementation(async ({ where }: { where: { status: string | { in?: string[] } } }) => where.status === 'OVERDUE' ? [task] : []);

    const result = await runDeadlineSweep(db, now, { notifications: notification() });

    expect(result.tasksEscalated).toBe(0);
    expect(raw.escalationRule.findMany).toHaveBeenCalled();
  });

  it('creates exactly one configured escalation, sends the mock notification, and audits it', async () => {
    const task = {
      id: 'task-1', incidentId: 'incident-1', title: 'Inspect pump', status: 'OVERDUE', deadline: new Date(now.getTime() - 60_000), escalations: [],
      incident: { id: 'incident-1', incidentNumber: 'INC-1', title: 'Pump noise', status: 'OVERDUE', isEmergency: false, responsibleDepartment: 'Maintenance', priority: 'HIGH' },
      assigneeId: 'employee-1', assignee: { id: 'employee-1', email: 'worker@example.test', manager: { id: 'manager-1', email: 'manager@example.test' }, department: null }
    };
    const policy = { id: 'policy-1', enabled: true, department: { name: 'Maintenance' }, priority: 'HIGH', escalateAfterMinutes: 0, reminderBeforeMinutes: 15 };
    const { db, tx, raw } = fakeDb();
    raw.task.findMany = vi.fn().mockImplementation(async ({ where }: { where: { status: string | { in?: string[] } } }) => where.status === 'OVERDUE' ? [task] : []);
    raw.task.findUnique = vi.fn().mockResolvedValue(task);
    raw.escalationRule.findMany = vi.fn().mockResolvedValue([policy]);
    const notices = notification();

    const result = await runDeadlineSweep(db, now, { notifications: notices });

    expect(result.tasksEscalated).toBe(1);
    expect(tx.task.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'task-1', status: 'OVERDUE', escalations: { none: {} } }, data: { status: 'ESCALATED' } }));
    expect(tx.escalation.create).toHaveBeenCalledWith({ data: { taskId: 'task-1', managerId: 'manager-1', level: 1, reason: 'The task passed its configured escalation threshold.' } });
    expect(notices.send).toHaveBeenCalledWith(db, expect.objectContaining({ kind: 'ESCALATION', recipientId: 'manager-1' }));
    expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'TASK_ESCALATED', metadata: expect.objectContaining({ policyId: 'policy-1' }) }) }));
  });

  it('bypasses reminder and overdue handling for emergency incidents while dispatching and auditing the alert', async () => {
    const emergencyReminder = reminderFixture({ task: {
      ...reminderFixture().task,
      incident: { id: 'incident-1', incidentNumber: 'INC-EM', title: 'Smoke', status: 'EMERGENCY', isEmergency: true }
    } });
    const event = { id: 'event-1', incidentId: 'incident-1', kind: 'IMMEDIATE_ALERT', status: 'PENDING', attemptCount: 0, reason: 'smoke', metadata: null,
      incident: { id: 'incident-1', incidentNumber: 'INC-EM', title: 'Smoke', status: 'EMERGENCY', isEmergency: true, location: 'Line 1' } };
    const { db, tx, raw } = fakeDb();
    raw.emergencyEvent.findMany = vi.fn().mockResolvedValue([event]);
    raw.emergencyEvent.findUnique = vi.fn().mockResolvedValue(event);
    raw.emergencyEvent.updateMany = vi.fn().mockResolvedValue({ count: 1 });
    raw.reminder.findMany = vi.fn().mockResolvedValue([emergencyReminder]);
    const alerts = { alert: vi.fn().mockResolvedValue({ status: 'SIMULATED' }) } as unknown as EmergencyAlertProvider;

    const result = await runDeadlineSweep(db, now, { notifications: notification(), emergencyAlerts: alerts });

    expect(result.emergencyAlertsAttempted).toBe(1);
    expect(result.remindersSent).toBe(0);
    expect(alerts.alert).toHaveBeenCalledWith(expect.objectContaining({ incidentId: 'incident-1', incidentNumber: 'INC-EM' }));
    expect(tx.emergencyEvent.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'SIMULATED', alertedAt: now } }));
    expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'EMERGENCY_ALERT_DISPATCHED' }) }));
    expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'EMERGENCY_REMINDER_BYPASSED' }) }));
  });

  it('retries pending reporter requests from the existing background worker', async () => {
    const verification = {
      id: 'verification-1', incidentId: 'incident-1', reporterId: 'reporter-1', status: 'PENDING', deliveryStatus: 'FAILED', attemptCount: 1,
      language: 'ta', prompt: 'தமிழ் prompt', incident: { id: 'incident-1', reporterId: 'reporter-1', status: 'REPORTER_VERIFICATION_PENDING' }
    };
    const { db, tx, raw } = fakeDb();
    raw.closureVerification.findMany = vi.fn().mockResolvedValue([verification]);
    raw.closureVerification.findUnique = vi.fn().mockResolvedValue(verification);
    raw.closureVerification.updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const tts = { speak: vi.fn().mockResolvedValue(undefined) };
    const ivr = { call: vi.fn().mockResolvedValue({ status: 'SIMULATED' }) };

    const result = await runDeadlineSweep(db, now, { closureFeedback: { tts, ivr } });

    expect(result.closureRequestsSent).toBe(1);
    expect(tts.speak).toHaveBeenCalledWith(expect.objectContaining({ recipientId: 'reporter-1', language: 'ta', text: 'தமிழ் prompt' }));
    expect(ivr.call).toHaveBeenCalledWith(expect.objectContaining({ verificationId: 'verification-1', recipientId: 'reporter-1', language: 'ta' }));
    expect(tx.closureVerification.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { deliveryStatus: 'SENT' } }));
    expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'CLOSURE_NOTIFICATION_SENT' }) }));
  });

  it('does not invoke emergency or normal escalation without a valid deadline', async () => {
    const task = {
      id: 'task-1', incidentId: 'incident-1', status: 'OVERDUE', deadline: null, escalations: [],
      incident: { id: 'incident-1', incidentNumber: 'INC-1', status: 'OVERDUE', isEmergency: false, responsibleDepartment: 'Maintenance', priority: 'HIGH' },
      assigneeId: 'employee-1', assignee: { id: 'employee-1', email: 'worker@example.test', manager: { id: 'manager-1', email: 'manager@example.test' }, department: null }
    };
    const { db, raw } = fakeDb();
    raw.task.findUnique = vi.fn().mockResolvedValue(task);

    await expect(sendTaskEscalation(db, 'task-1', undefined, now, notification())).rejects.toThrow(/valid task deadline/);
    expect(raw.escalationRule.findMany).not.toHaveBeenCalled();
  });
});
