import { describe, expect, it, vi } from 'vitest';
import type { DatabaseClient } from '../db.js';
import { recordReporterVerification } from './closure.js';

function database(status = 'REPORTER_VERIFICATION_PENDING', reporterId = 'reporter-1') {
  const tx = {
    closureVerification: { update: vi.fn() },
    incident: { update: vi.fn() },
    voiceReport: { updateMany: vi.fn() },
    task: { updateMany: vi.fn() },
    auditLog: { createMany: vi.fn() }
  };
  const db = {
    incident: { findUnique: vi.fn().mockResolvedValue({ id: 'incident-1', reporterId, status, incidentNumber: 'INC-1', tasks: [] }) },
    closureVerification: { findFirst: vi.fn().mockResolvedValue({ id: 'verification-1', attemptNumber: 1 }) },
    voiceReport: { findFirst: vi.fn().mockResolvedValue({ language: 'ta' }) },
    $transaction: vi.fn((callback: (value: typeof tx) => unknown) => callback(tx))
  };
  return { db: db as unknown as DatabaseClient, tx };
}

describe('reporter closure verification', () => {
  it('closes only after the original reporter confirms and stores evidence', async () => {
    const { db, tx } = database();
    const result = await recordReporterVerification(db, 'incident-1', 'reporter-1', '1', 'photo://evidence-1');
    expect(result.status).toBe('CLOSED');
    expect(tx.closureVerification.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'CONFIRMED', evidenceRef: 'photo://evidence-1' }) }));
    expect(tx.incident.update).toHaveBeenNthCalledWith(1, expect.objectContaining({ data: expect.objectContaining({ status: 'REPORTER_CONFIRMED', reporterVerificationStatus: 'CONFIRMED' }) }));
    expect(tx.incident.update).toHaveBeenNthCalledWith(2, expect.objectContaining({ data: expect.objectContaining({ status: 'CLOSED', reporterVerifiedAt: expect.any(Date) }) }));
  });

  it('reopens rather than closing when the reporter rejects the fix', async () => {
    const { db, tx } = database();
    const result = await recordReporterVerification(db, 'incident-1', 'reporter-1', '2');
    expect(result.status).toBe('REOPENED');
    expect(tx.incident.update).toHaveBeenNthCalledWith(1, expect.objectContaining({ data: expect.objectContaining({ status: 'REPORTER_REJECTED', reporterVerificationStatus: 'REJECTED' }) }));
    expect(tx.incident.update).toHaveBeenNthCalledWith(2, expect.objectContaining({ data: expect.objectContaining({ status: 'REOPENED', reopenReason: expect.any(String) }) }));
    expect(tx.task.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'OPEN', completedAt: null } }));
  });

  it('rejects verification from anyone other than the original reporter', async () => {
    const { db, tx } = database('REPORTER_VERIFICATION_PENDING', 'reporter-1');
    await expect(recordReporterVerification(db, 'incident-1', 'someone-else', '1')).rejects.toThrow(/original reporter/);
    expect(tx.incident.update).not.toHaveBeenCalled();
  });
});
