import { afterEach, describe, expect, it, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { issueToken } from '../auth.js';
import type { DatabaseClient } from '../db.js';
import { createApp } from '../app.js';

afterEach(() => vi.unstubAllEnvs());

const token = issueToken({ sub: 'reporter-1', role: 'EMPLOYEE', email: 'reporter@example.test' });

async function withApi(run: (url: string) => Promise<void>, database: DatabaseClient = { auditLog: { create: vi.fn() } } as unknown as DatabaseClient) {
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

async function transcribe(url: string, bytes: Uint8Array, contentType = 'audio/webm;codecs=opus') {
  const form = new FormData();
  form.set('language', 'ta');
  const audioBytes = Uint8Array.from(bytes);
  form.set('audio', new File([audioBytes.buffer as ArrayBuffer], 'report.webm', { type: contentType }));
  return fetch(`${url}/api/voice/transcribe`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form
  });
}

describe('voice transcription API', () => {
  it('accepts browser WebM codec MIME labels and returns mock multilingual transcription', async () => {
    vi.stubEnv('STT_PROVIDER', 'mock');
    vi.stubEnv('MOCK_TRANSCRIPT', 'வணக்கம்');

    await withApi(async (url) => {
      const response = await transcribe(url, Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x01]));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ transcript: 'வணக்கம்', language: 'ta', confidence: 0.84 });
    });
  });

  it('rejects a file whose content does not match its audio MIME type', async () => {
    vi.stubEnv('STT_PROVIDER', 'mock');

    await withApi(async (url) => {
      const response = await transcribe(url, Buffer.from('<html>not an audio recording</html>'));
      expect(response.status).toBe(415);
      expect(await response.json()).toMatchObject({ error: 'The uploaded file does not match a supported audio format.' });
    });
  });

  it('rejects a voice report whose declared duration exceeds the 30-second capture limit', async () => {
    await withApi(async (url) => {
      const form = new FormData();
      form.set('language', 'hi');
      form.set('transcript', 'Machine 4 requires inspection');
      form.set('durationSeconds', '31');
      const response = await fetch(`${url}/api/voice/upload`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: form
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: 'Voice reports must be 30 seconds or shorter.' });
    });
  });

  it('persists the selected language and requests a retry when mock STT confidence is low', async () => {
    vi.stubEnv('STT_PROVIDER', 'mock');
    vi.stubEnv('MOCK_TRANSCRIPT', 'வணக்கம் machine noisy');
    vi.stubEnv('MOCK_STT_CONFIDENCE', '0.2');
    const create = vi.fn().mockResolvedValue({ id: 'voice-report-1' });
    const update = vi.fn().mockResolvedValue({ id: 'voice-report-1' });
    const database = {
      voiceReport: { create, update },
      auditLog: { create: vi.fn() }
    } as unknown as DatabaseClient;
    let uploadedPath = '';

    try {
      await withApi(async (url) => {
        const form = new FormData();
        form.set('language', 'ta');
        form.set('durationSeconds', '8');
        const audioBytes = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x01]);
        form.set('audio', new File([audioBytes.buffer as ArrayBuffer], 'report.webm', { type: 'audio/webm;codecs=opus' }));
        const response = await fetch(`${url}/api/voice/upload`, {
          method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form
        });
        uploadedPath = String(create.mock.calls[0]?.[0]?.data?.audioPath ?? '');
        expect(response.status).toBe(202);
        expect(await response.json()).toMatchObject({ retryRequired: true, confidence: 0.2, audioQuality: 'NOISY' });
        expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({ language: 'ta', audioMimeType: 'audio/webm', durationSeconds: 8, status: 'VOICE_RECEIVED' }) });
        expect(update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'voice-report-1' }, data: expect.objectContaining({ status: 'NEEDS_CLARIFICATION', retryCount: { increment: 1 } }) }));
      }, database);
    } finally {
      if (uploadedPath) await rm(path.resolve(process.cwd(), '../../', uploadedPath), { force: true });
    }
  });
});
