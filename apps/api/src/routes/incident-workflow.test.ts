import { describe, expect, it, vi } from 'vitest';
import { issueToken } from '../auth.js';
import type { DatabaseClient } from '../db.js';
import { createApp } from '../app.js';

const managerToken = issueToken({ sub: 'manager-1', role: 'MANAGER', email: 'manager@example.test' });

async function withApi(database: DatabaseClient, run: (url: string) => Promise<void>) {
  const server = createApp(database).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind a TCP port');
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function authorizedFetch(url: string, path: string, init: RequestInit = {}) {
  return fetch(`${url}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${managerToken}`, 'content-type': 'application/json', ...init.headers }
  });
}

describe('incident and task mutation access', () => {
  it('prevents a manager from editing an incident outside their reporting line', async () => {
    const update = vi.fn();
    const database = {
      incident: { findUnique: vi.fn().mockResolvedValue({
        id: 'incident-1', reporterId: 'reporter-1', tasks: [{ assigneeId: 'employee-1', assignee: { managerId: 'other-manager' } }]
      }), update },
      $transaction: vi.fn()
    } as unknown as DatabaseClient;

    await withApi(database, async (url) => {
      const response = await authorizedFetch(url, '/api/incidents/incident-1', {
        method: 'PATCH', body: JSON.stringify({ priority: 'HIGH' })
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: 'You cannot access this incident.' });
      expect(database.$transaction).not.toHaveBeenCalled();
    });
  });

  it('prevents a manager from changing a task outside their reporting line', async () => {
    const transaction = vi.fn();
    const database = {
      task: { findUnique: vi.fn().mockResolvedValue({
        id: 'task-1', incidentId: 'incident-1', assigneeId: 'employee-1', status: 'OPEN',
        incident: { id: 'incident-1', reporterId: 'reporter-1', status: 'OPEN', voiceReports: [] },
        assignee: { id: 'employee-1', managerId: 'other-manager' }
      }) },
      $transaction: transaction
    } as unknown as DatabaseClient;

    await withApi(database, async (url) => {
      const response = await authorizedFetch(url, '/api/tasks/task-1', {
        method: 'PATCH', body: JSON.stringify({ status: 'IN_PROGRESS' })
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: 'You cannot access this task.' });
      expect(transaction).not.toHaveBeenCalled();
    });
  });

  it('allows a manager to edit an incident they reported and records an audit event', async () => {
    const tx = {
      incident: { update: vi.fn().mockResolvedValue({ id: 'incident-1', priority: 'HIGH' }), findUnique: vi.fn() },
      task: { updateMany: vi.fn() },
      auditLog: { create: vi.fn() }
    };
    const transaction = vi.fn((callback: (client: typeof tx) => unknown) => callback(tx));
    const database = {
      incident: { findUnique: vi.fn().mockResolvedValue({
        id: 'incident-1', reporterId: 'manager-1', tasks: []
      }) },
      $transaction: transaction
    } as unknown as DatabaseClient;

    await withApi(database, async (url) => {
      const response = await authorizedFetch(url, '/api/incidents/incident-1', {
        method: 'PATCH', body: JSON.stringify({ priority: 'HIGH' })
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ incident: { id: 'incident-1', priority: 'HIGH' } });
      expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ actorId: 'manager-1', action: 'INCIDENT_UPDATED' })
      }));
    });
  });
});
