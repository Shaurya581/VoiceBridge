import { readFile } from 'node:fs/promises';

export interface Transcription {
  transcript: string;
  language: string;
  confidence: number;
}

export interface SpeechToTextProvider {
  transcribe(audioPath: string, mimeType: string): Promise<Transcription>;
}

export class MockSpeechToTextProvider implements SpeechToTextProvider {
  async transcribe(_audioPath: string, _mimeType: string): Promise<Transcription> {
    return {
      transcript: process.env.MOCK_TRANSCRIPT ?? 'Machine 4 is making a strange noise near the packaging line. Please inform maintenance and get it checked before the night shift.',
      language: 'en',
      confidence: 0.84
    };
  }
}

export class OpenAiSpeechToTextProvider implements SpeechToTextProvider {
  async transcribe(audioPath: string, mimeType: string): Promise<Transcription> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY is required when STT_PROVIDER=openai');
    const audio = await readFile(audioPath);
    const form = new FormData();
    form.set('model', process.env.OPENAI_STT_MODEL ?? 'whisper-1');
    form.set('file', new File([audio], 'report-audio', { type: mimeType }));
    form.set('response_format', 'verbose_json');
    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form
    });
    if (!response.ok) throw new Error(`Speech transcription failed with ${response.status}`);
    const payload = await response.json() as { text?: string; language?: string };
    if (!payload.text?.trim()) throw new Error('Speech provider returned an empty transcript');
    return { transcript: payload.text.trim(), language: payload.language ?? 'unknown', confidence: 0.85 };
  }
}

export function speechProvider(): SpeechToTextProvider {
  return process.env.STT_PROVIDER === 'openai' ? new OpenAiSpeechToTextProvider() : new MockSpeechToTextProvider();
}
