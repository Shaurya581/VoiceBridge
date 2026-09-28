import { readFile } from 'node:fs/promises';

export interface Transcription {
  transcript: string;
  language: string;
  /** Provider-reported confidence only. Null means the provider does not expose a calibrated score. */
  confidence: number | null;
  audioQuality: 'CLEAN' | 'NOISY' | 'UNKNOWN';
}

export interface SpeechToTextProvider {
  transcribe(audioPath: string, mimeType: string, language?: string, transcriptHint?: string): Promise<Transcription>;
}

export interface AudioPreprocessor {
  prepare(audioPath: string): Promise<{ audioPath: string; quality: 'CLEAN' | 'NOISY' | 'UNKNOWN'; noiseSuppressionApplied: boolean }>;
}

export class PassThroughAudioPreprocessor implements AudioPreprocessor {
  async prepare(audioPath: string) {
    return { audioPath, quality: 'UNKNOWN' as const, noiseSuppressionApplied: false };
  }
}

export function audioPreprocessor(): AudioPreprocessor {
  return new PassThroughAudioPreprocessor();
}

export class MockSpeechToTextProvider implements SpeechToTextProvider {
  async transcribe(_audioPath: string, _mimeType: string, language = 'hi', transcriptHint?: string): Promise<Transcription> {
    const confidence = Number(process.env.MOCK_STT_CONFIDENCE ?? 0.84);
    return {
      transcript: process.env.MOCK_TRANSCRIPT ?? transcriptHint ?? 'Machine 4 is making a strange noise near the packaging line. Please inform maintenance and get it checked before the night shift.',
      language: process.env.MOCK_STT_LANGUAGE ?? language,
      confidence,
      audioQuality: confidence < Number(process.env.STT_MIN_CONFIDENCE ?? 0.55) ? 'NOISY' : 'CLEAN'
    };
  }
}

export class OpenAiSpeechToTextProvider implements SpeechToTextProvider {
  async transcribe(audioPath: string, mimeType: string, language = 'hi'): Promise<Transcription> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY is required when STT_PROVIDER=openai');
    const audio = await readFile(audioPath);
    const form = new FormData();
    form.set('model', process.env.OPENAI_STT_MODEL ?? 'whisper-1');
    form.set('file', new File([audio], 'report-audio', { type: mimeType }));
    form.set('response_format', 'verbose_json');
    if (language === 'hi' || language === 'ta' || language === 'hinglish') form.set('language', language === 'hinglish' ? 'hi' : language);
    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form
    });
    if (!response.ok) throw new Error(`Speech transcription failed with ${response.status}`);
    const payload = await response.json() as { text?: string; language?: string };
    if (!payload.text?.trim()) throw new Error('Speech provider returned an empty transcript');
    // Whisper's verbose_json response does not contain a calibrated confidence score.
    return { transcript: payload.text.trim(), language: language === 'hinglish' ? 'hinglish' : payload.language ?? language, confidence: null, audioQuality: 'UNKNOWN' };
  }
}

/**
 * Adapter for a locally hosted IndicWhisper inference wrapper. The wrapper accepts
 * multipart fields `audio` and `language`, and returns { text, language?, confidence? }.
 * Keeping the model runtime behind HTTP lets the API remain a single deployable
 * backend without embedding GPU/Python dependencies in the application process.
 */
export class IndicWhisperSpeechToTextProvider implements SpeechToTextProvider {
  async transcribe(audioPath: string, mimeType: string, language = 'hi'): Promise<Transcription> {
    const endpoint = process.env.INDICWHISPER_ENDPOINT;
    if (!endpoint) throw new Error('INDICWHISPER_ENDPOINT is required when STT_PROVIDER=indicwhisper');
    const audio = await readFile(audioPath);
    const form = new FormData();
    form.set('audio', new File([audio], 'report-audio', { type: mimeType }));
    form.set('language', language);
    const headers = new Headers();
    if (process.env.INDICWHISPER_API_KEY) headers.set('Authorization', `Bearer ${process.env.INDICWHISPER_API_KEY}`);
    const response = await fetch(endpoint, { method: 'POST', headers, body: form, signal: AbortSignal.timeout(Number(process.env.STT_TIMEOUT_MS ?? 180_000)) });
    if (!response.ok) throw new Error(`IndicWhisper transcription failed with ${response.status}`);
    const payload = await response.json() as { text?: string; transcript?: string; language?: string; confidence?: number };
    const transcript = (payload.text ?? payload.transcript)?.trim();
    if (!transcript) throw new Error('IndicWhisper endpoint returned an empty transcript');
    const confidence = typeof payload.confidence === 'number' && Number.isFinite(payload.confidence)
      ? Math.max(0, Math.min(1, payload.confidence))
      : null;
    return { transcript, language: payload.language ?? language, confidence, audioQuality: 'UNKNOWN' };
  }
}

export function speechProvider(): SpeechToTextProvider {
  switch (process.env.STT_PROVIDER) {
    case 'openai': return new OpenAiSpeechToTextProvider();
    case 'indicwhisper': return new IndicWhisperSpeechToTextProvider();
    default: return new MockSpeechToTextProvider();
  }
}
