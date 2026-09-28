import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseClient } from '../db.js';
import { extractIncident } from './extraction.js';
import { MockSpeechToTextProvider } from './speech.js';
import { classifySafety } from './safety.js';
import { createIncidentWorkflow } from './workflow.js';
import { completeTaskForVerification, recordReporterVerification } from './closure.js';
import { runDeadlineSweep } from './worker.js';
import type { IVRProvider, TTSProvider } from './voice-feedback.js';

afterEach(() => vi.unstubAllEnvs());

function memoryWorkflowDb() {
  const reporter = { id: 'reporter-1', name: 'Original Reporter', email: 'reporter@example.test', role: 'EMPLOYEE', isActive: true };
  const manager = { id: 'manager-1', name: 'Maintenance Lead', email: 'manager@example.test', role: 'MANAGER', isActive: true, managerId: null };
  const assignee = { ...manager, id: 'assignee-1', name: 'Maintenance Lead', manager };
  const department = { id: 'department-1', name: 'Maintenance', employees: [assignee] };
  const report: Record<string, any> = { id: 'report-1', reporterId: reporter.id, transcript: '', language: 'hinglish', status: 'TRANSCRIBED' };
  const state: Record<string, any> = { incident: null, task: null, reminder: null, verification: null, escalations: [], audits: [], notices: [] };
  const detailTask = () => state.task && ({ ...state.task, assignee, incident: { ...state.incident, voiceReports: [report], tasks: [{ ...state.task, assignee }] }, escalations: [...state.escalations] });
  const detailVerification = () => state.verification && ({ ...state.verification, incident: { ...state.incident, tasks: [{ ...state.task, assignee }] } });
  const db: any = {};
  db.$transaction = async (callback: (tx: any) => unknown) => callback(db);
  db.employee = {
    findUnique: async ({ where }: any) => where.id === reporter.id ? reporter : where.id === assignee.id ? assignee : null,
    findFirst: async () => assignee
  };
  db.department = { findFirst: async () => department };
  db.voiceReport = {
    findUnique: async () => report,
    update: async ({ data }: any) => Object.assign(report, data),
    updateMany: async ({ data }: any) => { Object.assign(report, data); return { count: 1 }; }
  };
  db.incident = {
    findMany: async () => [],
    findUnique: async () => state.incident,
    create: async ({ data }: any) => (state.incident = { id: 'incident-1', incidentNumber: 'INC-DEMO-1', ...data }),
    update: async ({ data }: any) => Object.assign(state.incident, data),
    updateMany: async ({ where, data }: any) => {
      if (!state.incident || (where.status && state.incident.status !== where.status)) return { count: 0 };
      Object.assign(state.incident, data); return { count: 1 };
    }
  };
  db.task = {
    create: async ({ data }: any) => (state.task = { id: 'task-1', completedAt: null, ...data }),
    findUnique: async () => detailTask(),
    findMany: async ({ where }: any) => {
      const task = detailTask();
      if (!task) return [];
      const statuses = typeof where.status === 'string' ? [where.status] : where.status?.in;
      if (statuses && !statuses.includes(task.status)) return [];
      if (where.deadline?.lte && task.deadline > where.deadline.lte) return [];
      if (where.incident?.isEmergency === false && task.incident.isEmergency) return [];
      if (where.escalations?.none && state.escalations.length) return [];
      return [task];
    },
    updateMany: async ({ where, data }: any) => {
      if (!state.task) return { count: 0 };
      const statuses = typeof where.status === 'string' ? [where.status] : where.status?.in;
      if (statuses && !statuses.includes(state.task.status)) return { count: 0 };
      if (where.escalations?.none && state.escalations.length) return { count: 0 };
      if (where.deadline?.lte && state.task.deadline > where.deadline.lte) return { count: 0 };
      Object.assign(state.task, data); return { count: 1 };
    }
  };
  db.assignment = { create: async () => ({ id: 'assignment-1' }) };
  db.escalationRule = { findMany: async () => [{ id: 'rule-1', enabled: true, department, priority: null, reminderBeforeMinutes: 60, escalateAfterMinutes: 0 }] };
  db.escalation = { create: async ({ data }: any) => { const value = { id: 'escalation-1', ...data }; state.escalations.push(value); return value; } };
  db.reminder = {
    create: async ({ data }: any) => (state.reminder = { id: 'reminder-1', attemptCount: 0, ...data }),
    findMany: async ({ where }: any) => state.reminder && ['PENDING', 'FAILED'].includes(state.reminder.status) && state.reminder.scheduledAt <= where.scheduledAt.lte ? [{ ...state.reminder, task: detailTask() }] : [],
    updateMany: async ({ where, data }: any) => {
      if (!state.reminder) return { count: 0 };
      const statuses = typeof where.status === 'string' ? [where.status] : where.status?.in;
      if (statuses && !statuses.includes(state.reminder.status)) return { count: 0 };
      Object.assign(state.reminder, data);
      if (data.attemptCount?.increment) state.reminder.attemptCount += data.attemptCount.increment;
      return { count: 1 };
    },
    update: async ({ data }: any) => Object.assign(state.reminder, data)
  };
  db.closureVerification = {
    count: async () => state.verification ? 1 : 0,
    create: async ({ data }: any) => (state.verification = { id: 'verification-1', status: 'PENDING', deliveryStatus: 'PENDING', attemptCount: 0, ...data }),
    findUnique: async () => detailVerification(),
    findMany: async () => [],
    updateMany: async ({ where, data }: any) => {
      if (!state.verification) return { count: 0 };
      if (where.status && state.verification.status !== where.status) return { count: 0 };
      if (where.deliveryStatus && (Array.isArray(where.deliveryStatus.in) ? !where.deliveryStatus.in.includes(state.verification.deliveryStatus) : state.verification.deliveryStatus !== where.deliveryStatus)) return { count: 0 };
      Object.assign(state.verification, data);
      if (data.attemptCount?.increment) state.verification.attemptCount += data.attemptCount.increment;
      return { count: 1 };
    }
  };
  db.emergencyEvent = {
    create: async ({ data }: any) => (state.emergencyEvent = { id: 'emergency-1', attemptCount: 0, ...data }),
    findUnique: async () => state.emergencyEvent && ({ ...state.emergencyEvent, incident: state.incident }),
    findMany: async () => state.emergencyEvent && ['PENDING', 'FAILED'].includes(state.emergencyEvent.status) ? [state.emergencyEvent] : [],
    updateMany: async ({ where, data }: any) => {
      if (!state.emergencyEvent) return { count: 0 };
      const statuses = typeof where.status === 'string' ? [where.status] : where.status?.in;
      if (statuses && !statuses.includes(state.emergencyEvent.status)) return { count: 0 };
      Object.assign(state.emergencyEvent, data);
      if (data.attemptCount?.increment) state.emergencyEvent.attemptCount += data.attemptCount.increment;
      return { count: 1 };
    }
  };
  db.notification = {
    create: async ({ data }: any) => { const notice = { id: `notice-${state.notices.length + 1}`, ...data }; state.notices.push(notice); return notice; },
    update: async ({ where, data }: any) => Object.assign(state.notices.find((notice: any) => notice.id === where.id), data)
  };
  db.auditLog = {
    create: async ({ data }: any) => { state.audits.push(data); return data; },
    createMany: async ({ data }: any) => { state.audits.push(...data); return { count: data.length }; }
  };
  return { db: db as DatabaseClient, state, report };
}

describe('Phase 8 deterministic acceptance scenarios', () => {
  it('runs a Hinglish report through routing, reminder, escalation, assignee completion, and reporter closure', async () => {
    vi.stubEnv('LLM_PROVIDER', 'mock');
    vi.stubEnv('MOCK_EMAIL', 'true');
    vi.stubEnv('MOCK_TTS', 'true');
    const transcript = 'Machine 4 se strange noise aa rahi hai packaging line ke paas, Maintenance ko check karna hai within 4 hours.';
    const shiftDeadlineTranscript = 'Machine 4 se strange noise aa rahi hai packaging line ke paas, night shift se pehle Maintenance ko check karna hai.';
    const shiftDeadlineExtraction = await extractIncident(shiftDeadlineTranscript, 'hinglish');
    expect(shiftDeadlineExtraction.location).toBe('packaging line');
    expect(shiftDeadlineExtraction.missingInformation).toContain('deadline');
    expect(shiftDeadlineExtraction.requiresConfirmation).toBe(true);

    const speech = await new MockSpeechToTextProvider().transcribe('/unused', 'audio/webm', 'hinglish', transcript);
    const extraction = await extractIncident(speech.transcript, speech.language);
    expect(speech.language).toBe('hinglish');
    expect(extraction).toMatchObject({ asset: 'Machine 4', location: 'packaging line', responsibleDepartment: 'Maintenance', priority: 'HIGH', requiresConfirmation: false });
    expect(classifySafety(speech.transcript).emergency).toBe(false);

    const { db, state, report } = memoryWorkflowDb();
    report.transcript = speech.transcript;
    report.language = speech.language;
    const created = await createIncidentWorkflow(db, { reporterId: 'reporter-1', voiceReportId: report.id, extraction });
    expect(created.incident.status).toBe('OPEN');
    expect(created.task.deadline).toEqual(new Date(extraction.deadline));
    expect(created.resolution.department).toBe('Maintenance');
    expect(state.reminder.status).toBe('PENDING');
    expect(state.notices.map((notice: any) => notice.kind)).toEqual(expect.arrayContaining(['ASSIGNMENT', 'REPORTER_UPDATE']));

    const reminderRun = await runDeadlineSweep(db, new Date(new Date(extraction.deadline).getTime() - 30 * 60_000));
    expect(reminderRun.remindersSent).toBe(1);
    expect(state.audits.some((event: any) => event.action === 'REMINDER_SENT')).toBe(true);
    const overdueRun = await runDeadlineSweep(db, new Date(new Date(extraction.deadline).getTime() + 1));
    expect(overdueRun.tasksOverdue).toBe(1);
    expect(overdueRun.tasksEscalated).toBe(1);
    expect(state.incident.status).toBe('ESCALATED');

    const speak = vi.fn().mockResolvedValue(undefined);
    const call = vi.fn().mockResolvedValue({ status: 'SIMULATED', response: '1' });
    const completed = await completeTaskForVerification(db, 'task-1', 'assignee-1', { tts: { speak } as TTSProvider, ivr: { call } as IVRProvider });
    expect(completed.incidentStatus).toBe('CLOSED');
    expect(completed.verification).toMatchObject({ reporterId: 'reporter-1', language: 'hinglish', status: 'CONFIRMED', deliveryMode: 'MOCK' });
    expect(call).toHaveBeenCalledWith(expect.objectContaining({ recipientId: 'reporter-1', language: 'hinglish', verificationId: 'verification-1' }));
    expect(speak).toHaveBeenCalledWith(expect.objectContaining({ language: 'hinglish', recipientId: 'reporter-1', kind: 'CLOSURE_VERIFICATION_PROMPT' }));
    expect(state.audits.map((event: any) => event.action)).toEqual(expect.arrayContaining([
      'INCIDENT_CREATED', 'INCIDENT_ASSIGNED', 'TASK_CREATED', 'REMINDER_SENT', 'TASK_OVERDUE', 'TASK_ESCALATED',
      'TASK_COMPLETED_BY_ASSIGNEE', 'REPORTER_VERIFICATION_REQUESTED', 'CLOSURE_NOTIFICATION_SENT', 'REPORTER_CONFIRMED', 'INCIDENT_CLOSED'
    ]));
    expect((await recordReporterVerification(db, 'verification-1', 'reporter-1', '1')).alreadyProcessed).toBe(true);
  });

  it('detects a Hinglish gas leak and dispatches an immediate simulated emergency alert', async () => {
    vi.stubEnv('LLM_PROVIDER', 'mock');
    vi.stubEnv('MOCK_EMAIL', 'true');
    vi.stubEnv('MOCK_EMERGENCY', 'true');
    const transcript = 'Packaging area mein gas leak ho raha hai.';
    const speech = await new MockSpeechToTextProvider().transcribe('/unused', 'audio/webm', 'hinglish', transcript);
    const extraction = await extractIncident(speech.transcript, speech.language);
    const safety = classifySafety(speech.transcript);
    expect(safety).toMatchObject({ emergency: true, priority: 'CRITICAL' });
    expect(extraction.priority).toBe('CRITICAL');
    const { db, state, report } = memoryWorkflowDb();
    report.transcript = speech.transcript;
    report.language = speech.language;
    const created = await createIncidentWorkflow(db, { reporterId: 'reporter-1', voiceReportId: report.id, extraction });
    expect(created.incident).toMatchObject({ status: 'EMERGENCY', isEmergency: true, priority: 'CRITICAL', emergencyStatus: 'SIMULATED' });
    expect(state.emergencyEvent.status).toBe('SIMULATED');
    expect(state.reminder).toBeNull();
    expect(state.audits.map((event: any) => event.action)).toContain('EMERGENCY_ALERT_DISPATCHED');
    expect(state.audits.some((event: any) => event.action === 'TASK_CREATED' && event.metadata.reminderAt === null)).toBe(true);
  });
});
