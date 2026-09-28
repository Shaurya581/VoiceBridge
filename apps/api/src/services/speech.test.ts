import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IndicWhisperSpeechToTextProvider, OpenAiSpeechToTextProvider } from './speech.js';

afterEach(() => vi.unstubAllEnvs());

describe('speech providers', () => {
  it('posts IndicWhisper multipart audio with the selected language and bounds provider confidence', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'voicebridge-stt-'));
    const audioPath = path.join(directory, 'sample.webm');
    await writeFile(audioPath, 'test-audio');
    vi.stubEnv('INDICWHISPER_ENDPOINT', 'http://indicwhisper.test/transcribe');
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ text: 'வணக்கம்', language: 'ta', confidence: 1.4 }), { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;
    try {
      const result = await new IndicWhisperSpeechToTextProvider().transcribe(audioPath, 'audio/webm', 'ta');
      expect(result).toEqual({ transcript: 'வணக்கம்', language: 'ta', confidence: 1, audioQuality: 'UNKNOWN' });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://indicwhisper.test/transcribe');
      const form = init.body as FormData;
      expect(form.get('language')).toBe('ta');
      expect(await (form.get('audio') as File).text()).toBe('test-audio');
    } finally {
      globalThis.fetch = originalFetch;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('requires explicit configuration for the IndicWhisper endpoint', async () => {
    vi.stubEnv('INDICWHISPER_ENDPOINT', '');
    await expect(new IndicWhisperSpeechToTextProvider().transcribe('/missing', 'audio/wav')).rejects.toThrow('INDICWHISPER_ENDPOINT is required');
  });

  it('preserves the reporter-selected Hinglish label while the endpoint receives that selection', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'voicebridge-stt-'));
    const audioPath = path.join(directory, 'sample.webm');
    await writeFile(audioPath, 'test-audio');
    vi.stubEnv('INDICWHISPER_ENDPOINT', 'http://indicwhisper.test/transcribe');
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ text: 'machine band karo', language: 'hinglish' }), { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;
    try {
      const result = await new IndicWhisperSpeechToTextProvider().transcribe(audioPath, 'audio/webm', 'hinglish');
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect((init.body as FormData).get('language')).toBe('hinglish');
      expect(result.language).toBe('hinglish');
      expect(result.confidence).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not invent a confidence score when the provider response has none', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'voicebridge-stt-'));
    const audioPath = path.join(directory, 'sample.wav');
    await writeFile(audioPath, 'test-audio');
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ text: 'தமிழ்', language: 'ta' }), { status: 200 })) as typeof fetch;
    try {
      const result = await new OpenAiSpeechToTextProvider().transcribe(audioPath, 'audio/wav', 'ta');
      expect(result).toEqual({ transcript: 'தமிழ்', language: 'ta', confidence: null, audioQuality: 'UNKNOWN' });
    } finally {
      globalThis.fetch = originalFetch;
      await rm(directory, { recursive: true, force: true });
    }
  });
});
