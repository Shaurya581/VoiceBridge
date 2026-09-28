import { describe, expect, it, vi } from 'vitest';
import type { DatabaseClient } from '../db.js';
import { notificationProvider } from './email.js';

describe('mock notification provider', () => {
  it('records a notification and marks the simulated delivery sent', async () => {
    vi.stubEnv('MOCK_EMAIL', 'true');
    const create = vi.fn().mockResolvedValue({ id: 'notification-1' });
    const update = vi.fn().mockResolvedValue({ id: 'notification-1', status: 'SENT' });
    const db = { notification: { create, update } } as unknown as DatabaseClient;

    const result = await notificationProvider().send(db, {
      kind: 'REMINDER', to: 'worker@example.test', recipientId: 'worker-1', subject: 'Reminder', body: 'Please check the task.', incidentId: 'incident-1', taskId: 'task-1'
    });

    expect(result.status).toBe('SENT');
    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({ kind: 'REMINDER', recipientEmail: 'worker@example.test', status: 'PENDING', incidentId: 'incident-1', taskId: 'task-1' }) });
    expect(update).toHaveBeenCalledWith({ where: { id: 'notification-1' }, data: expect.objectContaining({ status: 'SENT', sentAt: expect.any(Date) }) });
    vi.unstubAllEnvs();
  });
});
