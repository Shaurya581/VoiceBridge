import { describe, expect, it, vi } from 'vitest';
import { issueToken } from '../auth.js';
import type { DatabaseClient } from '../db.js';
import { createApp } from '../app.js';

async function withApi(database: DatabaseClient, run: (url: string) => Promise<void>) {
  const server = createApp(database).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind a TCP port');
  try { await run(`http://127.0.0.1:${address.port}`); }
  finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

const tokenFor = (sub: string, role: 'EMPLOYEE' | 'MANAGER') => issueToken({ sub, role, email: `${sub}@example.test` });

describe('authorized escalation actions', () => {
  it('rejects an employee attempting a manager-only escalation action', async () => {
    const database = {} as DatabaseClient;
    await withApi(database, async (url) => {
      const response = await fetch(`${url}/api/tasks/task-1/escalate`, {
        method: 'POST', headers: { authorization: `Bearer ${tokenFor('employee-1', 'EMPLOYEE')}`, 'content-type': 'application/json' }, body: '{}'
      });
      expect(response.status).toBe(403);
    });
  });

  it('rejects a manager outside the assignee reporting line', async () => {
    const findUnique = vi.fn().mockResolvedValue({
      id: 'task-1', assigneeId: 'employee-1', assignee: { managerId: 'other-manager' }
    });
    const database = { task: { findUnique } } as unknown as DatabaseClient;
    await withApi(database, async (url) => {
      const response = await fetch(`${url}/api/tasks/task-1/escalate`, {
        method: 'POST', headers: { authorization: `Bearer ${tokenFor('manager-1', 'MANAGER')}`, 'content-type': 'application/json' }, body: '{}'
      });
      expect(response.status).toBe(403);
      expect(findUnique).toHaveBeenCalledTimes(1);
    });
  });

  it('allows a manager in the assignee reporting line to reach workflow validation', async () => {
    const findUnique = vi.fn().mockResolvedValue({
      id: 'task-1', assigneeId: 'employee-1', status: 'OPEN', incidentId: 'incident-1', deadline: new Date(Date.now() - 60_000), escalations: [],
      incident: { id: 'incident-1', status: 'OPEN', isEmergency: false, responsibleDepartment: 'Maintenance', priority: 'HIGH' },
      assignee: { id: 'employee-1', managerId: 'manager-1', manager: { id: 'manager-1', email: 'manager@example.test' }, department: null }
    });
    const database = { task: { findUnique }, escalationRule: { findMany: vi.fn() } } as unknown as DatabaseClient;
    await withApi(database, async (url) => {
      const response = await fetch(`${url}/api/tasks/task-1/escalate`, {
        method: 'POST', headers: { authorization: `Bearer ${tokenFor('manager-1', 'MANAGER')}`, 'content-type': 'application/json' }, body: '{}'
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: 'Only overdue tasks can be escalated' });
      expect(findUnique).toHaveBeenCalledTimes(2);
    });
  });
});
