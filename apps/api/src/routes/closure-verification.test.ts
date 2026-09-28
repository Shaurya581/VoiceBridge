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

function database() {
  return {
    closureVerification: { findUnique: vi.fn().mockResolvedValue({
      id: 'verification-1', incidentId: 'incident-1', reporterId: 'reporter-1', status: 'PENDING',
      incident: { id: 'incident-1', reporterId: 'reporter-1', status: 'REPORTER_VERIFICATION_PENDING', tasks: [] }
    }) },
    auditLog: { create: vi.fn().mockResolvedValue({}) }
  } as unknown as DatabaseClient;
}

describe('closure verification route authorization', () => {
  it.each([
    ['manager', 'manager-1', 'MANAGER' as const],
    ['assignee', 'assignee-1', 'EMPLOYEE' as const]
  ])('does not allow the %s to respond for the original reporter', async (_label, userId, role) => {
    const db = database();
    const token = issueToken({ sub: userId, role, email: `${userId}@example.test` });
    await withApi(db, async (url) => {
      const response = await fetch(`${url}/api/incidents/incident-1/verify-closure`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ verificationId: 'verification-1', response: '1' })
      });
      expect(response.status).toBe(403);
    });
  });

  it('rejects a verification request reused against a different incident', async () => {
    const db = database();
    const token = issueToken({ sub: 'reporter-1', role: 'EMPLOYEE', email: 'reporter@example.test' });
    await withApi(db, async (url) => {
      const response = await fetch(`${url}/api/incidents/another-incident/verify-closure`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ verificationId: 'verification-1', response: '1' })
      });
      expect(response.status).toBe(404);
    });
  });
});
