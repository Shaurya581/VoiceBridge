import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseClient } from '../db.js';
import type { IVRProvider, TTSProvider } from './voice-feedback.js';
import { buildClosurePrompt, buildClosureResultMessage, completeTaskForVerification, dispatchClosureVerification, recordReporterVerification } from './closure.js';

afterEach(() => vi.unstubAllEnvs());

const now = new Date('2026-09-28T12:00:00.000Z');
const reporterId = 'reporter-1';
const incidentId = 'incident-1';
const verificationId = 'verification-1';
const completedAt = new Date('2026-09-28T11:45:00.000Z');

function verificationRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: verificationId, incidentId, reporterId, status: 'PENDING', response: null, attemptNumber: 1,
    evidenceRef: null, taskCompletedAt: completedAt, language: 'hi', prompt: 'Machine 4 की समस्या ठीक बताई गई है।',
    deliveryMode: 'MOCK', deliveryStatus: 'SENT', attemptCount: 1, lastAttemptAt: completedAt,
    incident: {
      id: incidentId, reporterId, status: 'REPORTER_VERIFICATION_PENDING', incidentNumber: 'INC-1', title: 'Machine 4 noise', asset: 'Machine 4',
      tasks: [{ id: 'task-1', assignee: { id: 'assignee-1', email: 'assignee@example.test' } }]
    },
    ...overrides
  };
}

function responseDb(record = verificationRecord()) {
  const tx = {
    closureVerification: { updateMany: vi.fn().mockResolvedValue({ count: 1 }), findUnique: vi.fn().mockResolvedValue({ ...record, status: 'CONFIRMED' }) },
    incident: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    voiceReport: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    task: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    auditLog: { create: vi.fn().mockResolvedValue({}), createMany: vi.fn().mockResolvedValue({ count: 3 }) }
  };
  const db = {
    closureVerification: { findUnique: vi.fn().mockResolvedValue(record) },
    voiceReport: { findFirst: vi.fn().mockResolvedValue({ language: record.language }) },
    notification: { create: vi.fn().mockResolvedValue({ id: 'notice-1' }), update: vi.fn().mockResolvedValue({ id: 'notice-1', status: 'SENT' }) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    $transaction: vi.fn((callback: (value: typeof tx) => unknown) => callback(tx))
  };
  return { db: db as unknown as DatabaseClient, tx, raw: db };
}

describe('spoken reporter closure verification', () => {
  it('builds short operational feedback in Hindi, Hinglish, and Tamil from incident data', () => {
    expect(buildClosurePrompt({ asset: 'Machine 4', title: 'Abnormal vibration' }, 'hi')).toContain('Machine 4');
    expect(buildClosurePrompt({ asset: 'Machine 4', title: 'Abnormal vibration' }, 'hi')).toContain('1 दबाएँ');
    expect(buildClosurePrompt({ asset: 'Machine 4', title: 'Abnormal vibration' }, 'hinglish')).toContain('1 dabayein');
    expect(buildClosurePrompt({ asset: 'Machine 4', title: 'Abnormal vibration' }, 'ta')).toContain('1 ஐ அழுத்துங்கள்');
    expect(buildClosureResultMessage(true, 'hi')).toContain('रिपोर्ट बंद');
    expect(buildClosureResultMessage(false, 'hinglish')).toContain('phir se open');
    expect(buildClosureResultMessage(false, 'ta')).toContain('மீண்டும் திறக்கப்பட்டது');
  });

  it('assignee completion creates a reporter-scoped pending request, speaks in the original reporter language, and audits the request', async () => {
    const task = {
      id: 'task-1', incidentId, status: 'IN_PROGRESS', incident: {
        id: incidentId, status: 'IN_PROGRESS', reporterId, title: 'Machine 4 noise', asset: 'Machine 4',
        voiceReports: [{ language: 'hinglish' }]
      }
    };
    const record = verificationRecord({ language: 'hinglish', prompt: buildClosurePrompt({ asset: 'Machine 4', title: 'Machine 4 noise' }, 'hinglish') });
    const tx = {
      task: { updateMany: vi.fn().mockResolvedValue({ count: 1 }), findUnique: vi.fn().mockResolvedValue({ id: 'task-1', status: 'COMPLETED_BY_ASSIGNEE', completedAt: now }) },
      incident: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      voiceReport: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      closureVerification: { count: vi.fn().mockResolvedValue(0), create: vi.fn().mockResolvedValue(record), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      auditLog: { createMany: vi.fn().mockResolvedValue({ count: 2 }), create: vi.fn().mockResolvedValue({}) }
    };
    const db = {
      task: { findUnique: vi.fn().mockResolvedValue(task) },
      employee: { findUnique: vi.fn().mockResolvedValue({ id: reporterId }) },
      closureVerification: { findUnique: vi.fn().mockResolvedValue(record), findMany: vi.fn() },
      incident: { findUnique: vi.fn().mockResolvedValue({ status: 'REPORTER_VERIFICATION_PENDING' }) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
      notification: { create: vi.fn().mockResolvedValue({ id: 'notice-1' }), update: vi.fn().mockResolvedValue({ id: 'notice-1', status: 'SENT' }) },
      $transaction: vi.fn((callback: (value: typeof tx) => unknown) => callback(tx))
    };
    const speak = vi.fn().mockResolvedValue(undefined);
    const call = vi.fn().mockResolvedValue({ status: 'SIMULATED' });
    const result = await completeTaskForVerification(db as unknown as DatabaseClient, 'task-1', 'assignee-1', { tts: { speak } as TTSProvider, ivr: { call } as IVRProvider });

    expect(tx.task.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'COMPLETED_BY_ASSIGNEE', completedAt: expect.any(Date) } }));
    expect(tx.closureVerification.create).toHaveBeenCalledWith({ data: expect.objectContaining({ reporterId, language: 'hinglish', deliveryStatus: 'PENDING', deliveryMode: 'MOCK', prompt: expect.stringContaining('1 dabayein') }) });
    expect(speak).toHaveBeenCalledWith(expect.objectContaining({ recipientId: reporterId, language: 'hinglish', kind: 'CLOSURE_VERIFICATION_PROMPT' }));
    expect(call).toHaveBeenCalledWith(expect.objectContaining({ verificationId, recipientId: reporterId, language: 'hinglish' }));
    expect(tx.auditLog.createMany).toHaveBeenCalledWith({ data: expect.arrayContaining([expect.objectContaining({ action: 'TASK_COMPLETED_BY_ASSIGNEE' }), expect.objectContaining({ action: 'REPORTER_VERIFICATION_REQUESTED' })]) });
    expect(result.incidentStatus).toBe('REPORTER_VERIFICATION_PENDING');
  });

  it('routes a Press 1 response through reporter confirmation to CLOSED and records evidence', async () => {
    const { db, tx } = responseDb();
    const speak = vi.fn().mockResolvedValue(undefined);
    const result = await recordReporterVerification(db, verificationId, reporterId, '1', 'photo://evidence-1', now, { tts: { speak } as TTSProvider });

    expect(result).toMatchObject({ status: 'CLOSED', alreadyProcessed: false });
    expect(tx.closureVerification.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: verificationId, reporterId, status: 'PENDING' }, data: expect.objectContaining({ status: 'CONFIRMED', response: '1', evidenceRef: 'photo://evidence-1', respondedAt: now }) }));
    expect(tx.incident.updateMany).toHaveBeenNthCalledWith(1, expect.objectContaining({ data: expect.objectContaining({ status: 'REPORTER_CONFIRMED', reporterVerificationStatus: 'CONFIRMED' }) }));
    expect(tx.incident.updateMany).toHaveBeenNthCalledWith(2, expect.objectContaining({ data: expect.objectContaining({ status: 'CLOSED', reporterVerifiedAt: now }) }));
    expect(tx.auditLog.createMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.arrayContaining([expect.objectContaining({ action: 'REPORTER_CONFIRMED' }), expect.objectContaining({ action: 'INCIDENT_CLOSED' })]) }));
    expect(speak).toHaveBeenCalledWith(expect.objectContaining({ language: 'hi', kind: 'FINAL_STATUS' }));
  });

  it('routes Press 2 to REOPENED and preserves the original task completion timestamp', async () => {
    const { db, tx } = responseDb(verificationRecord({ language: 'ta' }));
    const speak = vi.fn().mockResolvedValue(undefined);
    const result = await recordReporterVerification(db, verificationId, reporterId, '2', undefined, now, { tts: { speak } as TTSProvider });

    expect(result.status).toBe('REOPENED');
    expect(tx.incident.updateMany).toHaveBeenNthCalledWith(1, expect.objectContaining({ data: expect.objectContaining({ status: 'REPORTER_REJECTED', reporterVerificationStatus: 'REJECTED' }) }));
    expect(tx.incident.updateMany).toHaveBeenNthCalledWith(2, expect.objectContaining({ data: expect.objectContaining({ status: 'REOPENED', reopenedAt: now }) }));
    expect(tx.task.updateMany).toHaveBeenCalledWith({ where: { incidentId, status: 'COMPLETED_BY_ASSIGNEE' }, data: { status: 'OPEN' } });
    expect(tx.task.updateMany.mock.calls[0]?.[0].data).not.toHaveProperty('completedAt');
    expect(tx.auditLog.createMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.arrayContaining([expect.objectContaining({ action: 'REPORTER_REJECTED' }), expect.objectContaining({ action: 'INCIDENT_REOPENED' }), expect.objectContaining({ action: 'TASK_REOPENED' })]) }));
    expect(speak).toHaveBeenCalledWith(expect.objectContaining({ language: 'ta', text: expect.stringContaining('மீண்டும் திறக்கப்பட்டது') }));
  });

  it.each([
    ['invalid input', '0', 'REPORTER_VERIFICATION_INVALID_RESPONSE'],
    ['non-string IVR input', 0, 'REPORTER_VERIFICATION_INVALID_RESPONSE'],
    ['missing input', undefined, 'REPORTER_VERIFICATION_NO_RESPONSE']
  ])('keeps verification pending and audits %s', async (_label, input, action) => {
    const { db, tx, raw } = responseDb();
    const result = await recordReporterVerification(db, verificationId, reporterId, input, undefined, now);
    expect(result.status).toBe('REPORTER_VERIFICATION_PENDING');
    expect(tx.incident.updateMany).not.toHaveBeenCalled();
    expect(raw.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action }) }));
  });

  it('returns the recorded final state for duplicate callbacks without creating another transition', async () => {
    const record = verificationRecord({ status: 'CONFIRMED' });
    const { db, tx } = responseDb(record);
    const result = await recordReporterVerification(db, verificationId, reporterId, '2', undefined, now);
    expect(result).toMatchObject({ status: 'CLOSED', alreadyProcessed: true });
    expect(tx.incident.updateMany).not.toHaveBeenCalled();
    expect(tx.auditLog.createMany).not.toHaveBeenCalled();
  });

  it.each(['manager-1', 'assignee-1'])('rejects %s from confirming for the original reporter', async (unauthorizedId) => {
    const { db, tx } = responseDb();
    await expect(recordReporterVerification(db, verificationId, unauthorizedId, '1', undefined, now)).rejects.toThrow(/original reporter/);
    expect(tx.incident.updateMany).not.toHaveBeenCalled();
  });

  it('retries a failed spoken/IVR delivery with a bounded second provider attempt', async () => {
    const record = verificationRecord({ deliveryStatus: 'FAILED', attemptCount: 1 });
    let deliveryStatus = 'FAILED';
    let attempts = 1;
    const claim = vi.fn().mockImplementation(async ({ where, data }: { where: { deliveryStatus?: string | { in: string[] }; attemptCount?: { lt: number } }; data: { deliveryStatus: string; attemptCount?: { increment: number } } }) => {
      if (where.deliveryStatus === 'PROCESSING') {
        if (deliveryStatus !== 'PROCESSING') return { count: 0 };
        deliveryStatus = data.deliveryStatus;
        return { count: 1 };
      }
      const allowed = typeof where.deliveryStatus === 'object' && where.deliveryStatus !== null ? where.deliveryStatus.in : [];
      if (!allowed.includes(deliveryStatus) || attempts >= (where.attemptCount?.lt ?? 3)) return { count: 0 };
      deliveryStatus = data.deliveryStatus;
      attempts += data.attemptCount?.increment ?? 0;
      return { count: 1 };
    });
    const tx = { closureVerification: { updateMany: claim }, auditLog: { create: vi.fn().mockResolvedValue({}) } };
    const db = {
      closureVerification: { findUnique: vi.fn().mockImplementation(async () => ({ ...record, deliveryStatus, attemptCount: attempts })) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
      $transaction: vi.fn((callback: (value: typeof tx) => unknown) => callback(tx))
    } as unknown as DatabaseClient;
    const failedTts = { speak: vi.fn().mockRejectedValueOnce(new Error('TTS unavailable')).mockResolvedValueOnce(undefined) } as TTSProvider;
    const ivr = { call: vi.fn().mockResolvedValue({ status: 'SIMULATED' }) } as IVRProvider;

    const first = await dispatchClosureVerification(db, verificationId, now, { tts: failedTts, ivr });
    expect(deliveryStatus).toBe('FAILED');
    const second = await dispatchClosureVerification(db, verificationId, new Date(now.getTime() + 60_000), { tts: failedTts, ivr });

    expect(first).toMatchObject({ attempted: true, delivered: false });
    expect(second).toMatchObject({ attempted: true, delivered: true });
    expect(failedTts.speak).toHaveBeenCalledTimes(2);
    expect(ivr.call).toHaveBeenCalledTimes(1);
    expect(attempts).toBe(3);
    expect(deliveryStatus).toBe('SENT');
  });

  it('claims a verification request once when two worker sweeps race', async () => {
    let deliveryStatus = 'PENDING';
    const record = verificationRecord({ deliveryStatus: 'PENDING', attemptCount: 0 });
    let releaseSpeech!: () => void;
    const speechGate = new Promise<void>((resolve) => { releaseSpeech = resolve; });
    const claim = vi.fn().mockImplementation(async ({ where, data }: { where: { deliveryStatus?: string | { in: string[] } }; data: { deliveryStatus: string; attemptCount?: { increment: number } } }) => {
      if (where.deliveryStatus === 'PROCESSING' && deliveryStatus === 'PROCESSING') {
        deliveryStatus = data.deliveryStatus;
        return { count: 1 };
      }
      const allowed = typeof where.deliveryStatus === 'object' && where.deliveryStatus !== null ? where.deliveryStatus.in : [];
      if (allowed.includes(deliveryStatus)) {
        deliveryStatus = data.deliveryStatus;
        return { count: 1 };
      }
      return { count: 0 };
    });
    const tx = { closureVerification: { updateMany: claim }, auditLog: { create: vi.fn().mockResolvedValue({}) } };
    const rootAudit = vi.fn().mockResolvedValue({});
    const db = {
      closureVerification: { findUnique: vi.fn().mockResolvedValue(record) },
      auditLog: { create: rootAudit },
      $transaction: vi.fn((callback: (value: typeof tx) => unknown) => callback(tx))
    } as unknown as DatabaseClient;
    const speak = vi.fn().mockImplementation(() => speechGate);
    const call = vi.fn().mockResolvedValue({ status: 'SIMULATED' });

    const first = dispatchClosureVerification(db, verificationId, now, { tts: { speak } as TTSProvider, ivr: { call } as IVRProvider });
    await vi.waitFor(() => expect(speak).toHaveBeenCalledTimes(1));
    const second = await dispatchClosureVerification(db, verificationId, now, { tts: { speak } as TTSProvider, ivr: { call } as IVRProvider });
    releaseSpeech();
    const completed = await first;

    expect(second).toMatchObject({ attempted: false, delivered: false });
    expect(completed).toMatchObject({ attempted: true, delivered: true });
    expect(speak).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledTimes(1);
    expect(rootAudit).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'REPORTER_VERIFICATION_NO_RESPONSE' }) }));
  });
});
