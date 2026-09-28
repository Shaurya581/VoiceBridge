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
