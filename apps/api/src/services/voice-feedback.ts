export type SupportedLanguage = 'hi' | 'hinglish' | 'ta';

export interface TextToSpeechProvider {
  speak(input: { text: string; language: SupportedLanguage; recipientId: string; kind: string }): Promise<void>;
}

export interface IVRProvider {
  call(input: { phone?: string; recipientId: string; language: SupportedLanguage; prompt: string; kind: string }): Promise<{ status: 'SIMULATED' | 'PENDING'; response?: '1' | '2' }>;
}

export interface EmergencyAlertProvider {
  alert(input: { incidentId: string; incidentNumber: string; reason: string; recipientId?: string; recipient?: string }): Promise<{ status: 'SIMULATED' | 'PENDING' }>;
}

export class MockTextToSpeechProvider implements TextToSpeechProvider {
  async speak(input: { text: string; language: SupportedLanguage; recipientId: string; kind: string }) {
    console.info(JSON.stringify({ event: 'mock_tts', ...input }));
  }
}

export class MockIVRProvider implements IVRProvider {
  async call(input: { phone?: string; recipientId: string; language: SupportedLanguage; prompt: string; kind: string }) {
    console.info(JSON.stringify({ event: 'mock_ivr_call', ...input }));
    const configuredResponse = process.env.MOCK_IVR_RESPONSE;
    const response: '1' | '2' | undefined = configuredResponse === '1' || configuredResponse === '2' ? configuredResponse : undefined;
    return { status: 'SIMULATED' as const, ...(response ? { response } : {}) };
  }
}

export class MockEmergencyAlertProvider implements EmergencyAlertProvider {
  async alert(input: { incidentId: string; incidentNumber: string; reason: string; recipientId?: string; recipient?: string }) {
    console.info(JSON.stringify({ event: 'mock_emergency_alert', ...input }));
    return { status: 'SIMULATED' as const };
  }
}

export function textToSpeechProvider(): TextToSpeechProvider {
  if (process.env.MOCK_TTS === 'false') throw new Error('A real TTS provider is not configured in this Phase 1 prototype.');
  return new MockTextToSpeechProvider();
}

export function ivrProvider(): IVRProvider {
  if (process.env.MOCK_IVR === 'false') throw new Error('A real IVR provider is not configured in this Phase 1 prototype.');
  return new MockIVRProvider();
}

export function emergencyAlertProvider(): EmergencyAlertProvider {
  if (process.env.MOCK_EMERGENCY === 'false') throw new Error('A real emergency alert provider is not configured in this Phase 1 prototype.');
  return new MockEmergencyAlertProvider();
}

export async function speakStatus(input: { text: string; language: string | null; recipientId: string; kind: string }) {
  const language = normalizeLanguage(input.language);
  await textToSpeechProvider().speak({ ...input, language });
}

export function normalizeLanguage(language: string | null | undefined): SupportedLanguage {
  if (language === 'ta' || language?.toLowerCase().startsWith('ta')) return 'ta';
  if (language === 'hinglish') return 'hinglish';
  return 'hi';
}
