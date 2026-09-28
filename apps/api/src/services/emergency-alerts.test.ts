import { describe, expect, it, vi } from 'vitest';
import type { DatabaseClient } from '../db.js';
import type { NotificationProvider } from './email.js';
import type { EmergencyAlertProvider } from './voice-feedback.js';
import { dispatchEmergencyAlert } from './emergency-alerts.js';

const incident = { id: 'incident-1', incidentNumber: 'INC-EM-1', title: 'Smoke near motor', location: 'Factory floor' };
const event = { id: 'event-1', incidentId: incident.id, reason: 'Smoke detected', metadata: null, attemptCount: 0, incident };

describe('emergency alert retry', () => {
  it('audits failure and retries an emergency alert without entering normal workflow', async () => {
    let state = 'PENDING';
    let attempts = 0;
    const updateMany = vi.fn().mockImplementation(async ({ where, data }: { where: { status?: string | { in: string[] } }; data: { status: string; attemptCount?: { increment: number }; alertedAt?: Date } }) => {
      if (where.status === 'PROCESSING') {
        if (state !== 'PROCESSING') return { count: 0 };
        state = data.status;
        return { count: 1 };
      }
      const eligible = typeof where.status === 'object' && where.status !== null ? where.status.in : [];
      if (eligible.includes(state) && attempts < 3) {
        state = data.status;
        attempts += data.attemptCount?.increment ?? 0;
        return { count: 1 };
      }
      return { count: 0 };
    });
    const audits = vi.fn().mockResolvedValue({});
    const tx = {
      emergencyEvent: { updateMany },
      incident: { update: vi.fn().mockResolvedValue({}) },
      auditLog: { create: audits }
    };
    const db = {
      emergencyEvent: { findUnique: vi.fn().mockImplementation(async () => ({ ...event, status: state, attemptCount: attempts })) , updateMany },
      employee: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn((callback: (client: typeof tx) => unknown) => callback(tx))
    } as unknown as DatabaseClient;
    const provider = { alert: vi.fn().mockRejectedValueOnce(new Error('provider unavailable')).mockResolvedValueOnce({ status: 'SIMULATED' }) } as unknown as EmergencyAlertProvider;
    const notifications = { send: vi.fn() } as unknown as NotificationProvider;

    const failed = await dispatchEmergencyAlert(db, event.id, new Date('2026-09-28T12:00:00Z'), provider, notifications);
    const retried = await dispatchEmergencyAlert(db, event.id, new Date('2026-09-28T12:01:00Z'), provider, notifications);

    expect(failed).toMatchObject({ attempted: true, delivered: false });
    expect(retried).toMatchObject({ attempted: true, delivered: true, status: 'SIMULATED' });
    expect(provider.alert).toHaveBeenCalledTimes(2);
    expect(audits).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'EMERGENCY_ALERT_FAILED' }) }));
    expect(audits).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'EMERGENCY_ALERT_DISPATCHED' }) }));
  });
});
