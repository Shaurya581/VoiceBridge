import { describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';

async function withServer(run: (url: string) => Promise<void>, database: Parameters<typeof createApp>[0] = null) {
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

describe('GET /api/health', () => {
  it('returns service health when the database is not configured', async () => {
    await withServer(async (url) => {
      const response = await fetch(`${url}/api/health`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: 'ok', service: 'voicebridge-api', database: 'unconfigured' });
    });
  });

  it('reports a successful database connection', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] });
    const database = { $queryRawUnsafe: query } as unknown as Parameters<typeof createApp>[0];
    await withServer(async (url) => {
      const response = await fetch(`${url}/api/health`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: 'ok', database: 'connected' });
      expect(query).toHaveBeenCalledWith('SELECT 1');
    }, database);
  });

  it('checks the configured database and reports a connection failure', async () => {
    const query = vi.fn().mockRejectedValue(new Error('connection failed'));
    const database = { $queryRawUnsafe: query } as unknown as Parameters<typeof createApp>[0];
    await withServer(async (url) => {
      const response = await fetch(`${url}/api/health`);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ status: 'degraded', database: 'unavailable' });
      expect(query).toHaveBeenCalledWith('SELECT 1');
    }, database);
  });
});
