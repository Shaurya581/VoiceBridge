import { afterEach, describe, expect, it, vi } from 'vitest';
import { ivrProvider, normalizeLanguage, textToSpeechProvider, MockIVRProvider, MockTextToSpeechProvider } from './voice-feedback.js';

afterEach(() => vi.unstubAllEnvs());

describe('mock spoken-feedback providers', () => {
  it('normalizes supported reporter languages', () => {
    expect(normalizeLanguage('ta-IN')).toBe('ta');
    expect(normalizeLanguage('hinglish')).toBe('hinglish');
    expect(normalizeLanguage('hi-IN')).toBe('hi');
  });

  it('simulates TTS and IVR without paid providers', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await textToSpeechProvider().speak({ text: 'Report received', language: 'hi', recipientId: 'reporter-1', kind: 'ACK' });
    vi.stubEnv('MOCK_IVR_RESPONSE', '2');
    await expect(ivrProvider().call({ recipientId: 'reporter-1', language: 'ta', prompt: 'Press 1 or 2', kind: 'CLOSURE' })).resolves.toMatchObject({ status: 'SIMULATED', response: '2' });
    expect(log).toHaveBeenCalledTimes(2);
    log.mockRestore();
  });

  it('falls back to explicit mocks when real speech providers are unavailable', () => {
    vi.stubEnv('MOCK_TTS', 'false');
    vi.stubEnv('MOCK_IVR', 'false');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(textToSpeechProvider()).toBeInstanceOf(MockTextToSpeechProvider);
    expect(ivrProvider()).toBeInstanceOf(MockIVRProvider);
    expect(warning).toHaveBeenCalledTimes(2);
    warning.mockRestore();
  });
});
