import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyPriorityRules, extractIncident, extractionSchema, type IncidentExtraction } from './extraction.js';
import { MockSpeechToTextProvider } from './speech.js';

afterEach(() => vi.unstubAllEnvs());

const modelResponse: IncidentExtraction = {
  title: 'சத்தம் அருகில் இயந்திரம்',
  description: 'தீ அருகில் machine 4 சத்தம் வருகிறது',
  abnormality: 'சத்தம் வருகிறது',
  asset: 'machine 4',
  location: null,
  responsibleDepartment: 'Maintenance',
  responsiblePerson: null,
  priority: 'LOW',
  deadline: '2026-09-29T17:00:00.000Z',
  requestedAction: 'Please inspect machine 4',
  confidence: 0.94,
  missingInformation: [],
  requiresConfirmation: false
};

describe('structured incident extraction', () => {
  it('uses Ollama JSON-schema output, preserves source-language context, and applies deterministic safety/confirmation rules', async () => {
    vi.stubEnv('LLM_PROVIDER', 'ollama');
    vi.stubEnv('OLLAMA_BASE_URL', 'http://127.0.0.1:11434/');
    vi.stubEnv('OLLAMA_MODEL', 'llama3.1:8b');
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: { content: JSON.stringify(modelResponse) } }), { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;
    try {
      const transcript = 'தீ அருகில் machine 4 சத்தம் வருகிறது';
      const result = await extractIncident(transcript, 'ta');
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(String(init.body)) as { model: string; stream: boolean; format: { additionalProperties?: boolean; required?: string[] }; messages: Array<{ content: string }> };
      expect(url).toBe('http://127.0.0.1:11434/api/chat');
      expect(body).toMatchObject({ model: 'llama3.1:8b', stream: false });
      expect(body.format.additionalProperties).toBe(false);
      expect(body.format.required).toContain('responsiblePerson');
      expect(body.messages[0]?.content).toContain('ta');
      expect(body.messages[1]?.content).toContain(transcript);
      expect(result.description).toBe(transcript);
      expect(result.priority).toBe('CRITICAL');
      expect(result.missingInformation).toContain('deadline');
      expect(result.requiresConfirmation).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('keeps default mock extraction in the human-confirmation path when the transcript omits a deadline', async () => {
    vi.stubEnv('LLM_PROVIDER', 'mock');
    const result = await extractIncident('Machine 4 is making a strange noise near the packaging line. Please get it checked.', 'hinglish');
    expect(result.deadline).toMatch(/^\d{4}-\d\d-\d\dT/u);
    expect(result.missingInformation).toContain('deadline');
    expect(result.requiresConfirmation).toBe(true);
  });

  it('does not let a model downgrade an emergency priority', () => {
    expect(applyPriorityRules('மின்சார அதிர்ச்சி', 'LOW')).toBe('CRITICAL');
  });

  it('preserves a valid model priority when no deterministic override applies', () => {
    expect(applyPriorityRules('The cosmetic scratch is minor.', 'LOW')).toBe('LOW');
  });

  it('rejects extra model fields before they can enter workflow data', () => {
    expect(extractionSchema.safeParse({ ...modelResponse, assigneeId: 'arbitrary-user' }).success).toBe(false);
  });

  it('does not call a provider for a blank transcript', async () => {
    await expect(extractIncident('   ')).rejects.toThrow('empty transcript');
  });

  it.each([
    ['hi', 'मशीन 4 packaging line के पास तेज आवाज कर रही है। Maintenance कृपया जांचें।', true],
    ['hinglish', 'Machine 4 se strange noise aa rahi hai packaging line ke paas, Maintenance ko check karna hai within 4 hours.', false],
    ['ta', 'Packaging line அருகில் machine 4 அதிக சத்தம் செய்கிறது. Maintenance குழு check செய்யவும்.', true]
  ] as const)('preserves %s report language and source details without filling unsupported fields', async (language, transcript, needsDeadlineConfirmation) => {
    vi.stubEnv('LLM_PROVIDER', 'mock');
    const transcription = await new MockSpeechToTextProvider().transcribe('/unused', 'audio/webm', language, transcript);
    const result = await extractIncident(transcription.transcript, transcription.language);

    expect(transcription.language).toBe(language);
    expect(result.description).toBe(transcript);
    expect(result.responsiblePerson).toBeNull();
    expect(result.location?.toLowerCase()).toBe('packaging line');
    expect(result.missingInformation.includes('deadline')).toBe(needsDeadlineConfirmation);
    expect(result.requiresConfirmation).toBe(needsDeadlineConfirmation);
  });
});

describe('native-script multilingual mock extraction', () => {
  it('extracts location and department from a pure Hindi (Devanagari) transcript', async () => {
    vi.stubEnv('LLM_PROVIDER', 'mock');
    const result = await extractIncident('पैकेजिंग लाइन के पास मशीन से अजीब आवाज आ रही है', 'hi');
    expect(result.location).toBe('packaging line');
    expect(result.responsibleDepartment).toBe('Maintenance');
  });

  it('extracts a Hindi machine number and normalizes it to the English form', async () => {
    vi.stubEnv('LLM_PROVIDER', 'mock');
    const result = await extractIncident('मशीन 4 से बहुत तेज आवाज आ रही है', 'hi');
    expect(result.asset).toBe('Machine 4');
    expect(result.responsibleDepartment).toBe('Maintenance');
  });

  it('extracts location and department from a pure Tamil transcript', async () => {
    vi.stubEnv('LLM_PROVIDER', 'mock');
    const result = await extractIncident('பேக்கேஜிங் லைன் அருகில் இயந்திரம் அதிக சத்தம் செய்கிறது', 'ta');
    expect(result.location).toBe('packaging line');
    expect(result.responsibleDepartment).toBe('Maintenance');
  });

  it('still extracts from Romanized Hinglish after the native-script additions', async () => {
    vi.stubEnv('LLM_PROVIDER', 'mock');
    const result = await extractIncident('Machine 4 se strange noise aa rahi hai packaging line ke paas, Maintenance ko check karna hai within 4 hours.', 'hinglish');
    expect(result.location).toBe('packaging line');
    expect(result.responsibleDepartment).toBe('Maintenance');
    expect(result.asset).toBe('Machine 4');
    expect(result.requiresConfirmation).toBe(false);
  });

  it('still extracts from English after the native-script additions', async () => {
    vi.stubEnv('LLM_PROVIDER', 'mock');
    const result = await extractIncident('Pump 2 leaking near the boiler room, please fix it today', 'hinglish');
    expect(result.location).toBe('boiler room');
    expect(result.asset).toBe('Pump 2');
  });

  it('routes Hindi IT keywords to the IT department', async () => {
    vi.stubEnv('LLM_PROVIDER', 'mock');
    const result = await extractIncident('सर्वर रूम में नेटवर्क डाउन है कृपया जांचें', 'hi');
    expect(result.responsibleDepartment).toBe('IT');
    expect(result.location).toBe('server room');
  });

  it('routes Hindi Facilities keywords to the Facilities department', async () => {
    vi.stubEnv('LLM_PROVIDER', 'mock');
    const result = await extractIncident('कैफेटेरिया के पास पानी का रिसाव हो रहा है', 'hi');
    expect(result.responsibleDepartment).toBe('Facilities');
    expect(result.location).toBe('cafeteria');
  });
});

describe('transliterated Hinglish extraction compatibility', () => {
  it('extracts location and department from Romanized Hinglish that was transliterated from Devanagari', async () => {
    vi.stubEnv('LLM_PROVIDER', 'mock');
    // This simulates the output of transliterateHinglish() applied to Devanagari
    const result = await extractIncident('packaging line ke paas machine se ajeeb awaaz aa rahi hai', 'hinglish');
    expect(result.location).toBe('packaging line');
    expect(result.responsibleDepartment).toBe('Maintenance');
  });

  it('extracts from an English transcript', async () => {
    vi.stubEnv('LLM_PROVIDER', 'mock');
    const result = await extractIncident('Machine 4 is making a strange noise near the packaging line. Please get it checked.', 'en');
    expect(result.location).toBe('packaging line');
    expect(result.asset).toBe('Machine 4');
  });
});

describe('Hinglish workplace location extraction robustness', () => {
  it('1. extracts Roman Hinglish with "ke paas"', async () => {
    vi.stubEnv('LLM_PROVIDER', 'mock');
    const result = await extractIncident('Machine 4 packaging line ke paas ajeeb noise', 'hinglish');
    expect(result.location).toBe('packaging line');
    expect(result.responsibleDepartment).toBe('Maintenance');
  });

  it('2. extracts Roman Hinglish with "mein"', async () => {
    vi.stubEnv('LLM_PROVIDER', 'mock');
    const result = await extractIncident('Machine 4 packaging line mein ajeeb noise', 'hinglish');
    expect(result.location).toBe('packaging line');
    expect(result.responsibleDepartment).toBe('Maintenance');
  });

  it('3. extracts Roman Hinglish with "pe"', async () => {
    vi.stubEnv('LLM_PROVIDER', 'mock');
    const result = await extractIncident('Machine 4 packaging line pe ajeeb noise', 'hinglish');
    expect(result.location).toBe('packaging line');
    expect(result.responsibleDepartment).toBe('Maintenance');
  });

  it('4. extracts Roman Hinglish with "par"', async () => {
    vi.stubEnv('LLM_PROVIDER', 'mock');
    const result = await extractIncident('Machine 4 packaging line par ajeeb noise', 'hinglish');
    expect(result.location).toBe('packaging line');
    expect(result.responsibleDepartment).toBe('Maintenance');
  });

  it('5. extracts Roman Hinglish with "ke samne"', async () => {
    vi.stubEnv('LLM_PROVIDER', 'mock');
    const result = await extractIncident('Machine 4 packaging line ke samne ajeeb noise', 'hinglish');
    expect(result.location).toBe('packaging line');
    expect(result.responsibleDepartment).toBe('Maintenance');
  });

  it('6. extracts Roman Hinglish standalone workplace without postposition', async () => {
    vi.stubEnv('LLM_PROVIDER', 'mock');
    const result = await extractIncident('Machine 4 packaging line', 'hinglish');
    expect(result.location).toBe('packaging line');
    expect(result.responsibleDepartment).toBe('Maintenance');
  });

  it('7. preserves existing Hindi location extraction', async () => {
    vi.stubEnv('LLM_PROVIDER', 'mock');
    const result = await extractIncident('मशीन 4 पैकेजिंग लाइन के पास खराब आवाज कर रही है', 'hi');
    expect(result.location).toBe('packaging line');
    expect(result.responsibleDepartment).toBe('Maintenance');
  });

  it('8. preserves existing Tamil location extraction', async () => {
    vi.stubEnv('LLM_PROVIDER', 'mock');
    const result = await extractIncident('பேக்கேஜிங் லைன் அருகில் இயந்திரம் அதிக சத்தம் செய்கிறது', 'ta');
    expect(result.location).toBe('packaging line');
    expect(result.responsibleDepartment).toBe('Maintenance');
  });

  it('9. preserves existing English location extraction', async () => {
    vi.stubEnv('LLM_PROVIDER', 'mock');
    const result = await extractIncident('Machine 4 is making a strange noise near the packaging line.', 'en');
    expect(result.location).toBe('packaging line');
    expect(result.responsibleDepartment).toBe('Maintenance');
  });
});
