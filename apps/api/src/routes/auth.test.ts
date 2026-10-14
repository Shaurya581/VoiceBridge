import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import type { DatabaseClient } from '../db.js';

afterEach(() => vi.unstubAllEnvs());

async function withApi(run: (url: string) => Promise<void>, database: DatabaseClient) {
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

describe('POST /api/auth/google', () => {
  it('signs in an existing employee via Google email', async () => {
    const existingEmployee = {
      id: 'emp-123',
      name: 'Sam Reporter',
      email: 'employee@voicebridge.local',
      role: 'EMPLOYEE',
      isActive: true,
      department: { name: 'Maintenance' }
    };
    const auditCreate = vi.fn().mockResolvedValue({});
    const db = {
      employee: {
        findUnique: vi.fn().mockResolvedValue(existingEmployee)
      },
      auditLog: {
        create: auditCreate
      }
    } as unknown as DatabaseClient;

    await withApi(async (url) => {
      const response = await fetch(`${url}/api/auth/google`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'employee@voicebridge.local' })
      });
      expect(response.status).toBe(200);
      const data = await response.json() as { user: { email: string; name: string }; token: string; authMethod: string };
      expect(data.user.email).toBe('employee@voicebridge.local');
      expect(data.user.name).toBe('Sam Reporter');
      expect(data.token).toBeTruthy();
      expect(data.authMethod).toBe('google');
      expect(auditCreate).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          action: 'GOOGLE_LOGIN',
          actorId: 'emp-123'
        })
      }));
    }, db);
  });

  it('auto-provisions a new employee when signing in with Google', async () => {
    const createdEmployee = {
      id: 'emp-new',
      name: 'Google Employee',
      email: 'newbie@company.com',
      role: 'EMPLOYEE',
      department: { name: 'Operations' }
    };
    const auditCreate = vi.fn().mockResolvedValue({});
    const db = {
      employee: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue(createdEmployee)
      },
      department: {
        findFirst: vi.fn().mockResolvedValue({ id: 'dept-ops', name: 'Operations' })
      },
      auditLog: {
        create: auditCreate
      }
    } as unknown as DatabaseClient;

    await withApi(async (url) => {
      const response = await fetch(`${url}/api/auth/google`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'newbie@company.com', name: 'Google Employee' })
      });
      expect(response.status).toBe(200);
      const data = await response.json() as { user: { email: string }; token: string };
      expect(data.user.email).toBe('newbie@company.com');
      expect(data.token).toBeTruthy();
    }, db);
  });

  it('decodes Google ID token credential payload and signs in', async () => {
    const payload = {
      email: 'alex@company.com',
      name: 'Alex Google',
      sub: 'google-sub-123'
    };
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const mockGoogleJwt = `${header}.${body}.mock-signature`;

    const existingEmployee = {
      id: 'emp-alex',
      name: 'Alex Google',
      email: 'alex@company.com',
      role: 'EMPLOYEE',
      isActive: true,
      department: { name: 'Security' }
    };
    const db = {
      employee: {
        findUnique: vi.fn().mockResolvedValue(existingEmployee)
      },
      auditLog: {
        create: vi.fn().mockResolvedValue({})
      }
    } as unknown as DatabaseClient;

    await withApi(async (url) => {
      const response = await fetch(`${url}/api/auth/google`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ credential: mockGoogleJwt })
      });
      expect(response.status).toBe(200);
      const data = await response.json() as { user: { email: string }; token: string };
      expect(data.user.email).toBe('alex@company.com');
    }, db);
  });

  it('rejects deactivated employees with 403', async () => {
    const db = {
      employee: {
        findUnique: vi.fn().mockResolvedValue({ id: 'emp-99', isActive: false, email: 'disabled@company.com' })
      }
    } as unknown as DatabaseClient;

    await withApi(async (url) => {
      const response = await fetch(`${url}/api/auth/google`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'disabled@company.com' })
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: 'Account has been deactivated.' });
    }, db);
  });

  it('rejects requests with missing credentials/email with 400', async () => {
    const db = {} as DatabaseClient;
    await withApi(async (url) => {
      const response = await fetch(`${url}/api/auth/google`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({})
      });
      expect(response.status).toBe(400);
    }, db);
  });
});
