import { z } from 'zod';
import type { Priority } from '../generated/prisma/enums.js';
import { classifySafety } from './safety.js';

export const extractionSchema = z.object({
  title: z.string().trim().min(3).max(160),
  description: z.string().trim().min(3).max(4000),
  abnormality: z.string().trim().max(500).nullable(),
  asset: z.string().trim().max(200).nullable(),
  location: z.string().trim().max(300).nullable(),
  responsibleDepartment: z.string().trim().max(100).nullable(),
  responsiblePerson: z.string().trim().max(160).nullable(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  deadline: z.string().datetime(),
  requestedAction: z.string().trim().min(3).max(500),
  confidence: z.number().min(0).max(1),
  missingInformation: z.array(z.string().trim().min(1).max(160)).max(12),
  requiresConfirmation: z.boolean()
}).strict();

export type IncidentExtraction = z.infer<typeof extractionSchema>;

export interface IncidentExtractionProvider {
  extract(transcript: string, language?: string): Promise<IncidentExtraction>;
}

const departmentNames = ['Maintenance', 'Facilities', 'IT', 'Security', 'Operations', 'HR'];
const slaHours: Record<Priority, number> = {
  LOW: Number(process.env.SLA_LOW_HOURS ?? 48),
  MEDIUM: Number(process.env.SLA_MEDIUM_HOURS ?? 24),
  HIGH: Number(process.env.SLA_HIGH_HOURS ?? 8),
  CRITICAL: Number(process.env.SLA_CRITICAL_HOURS ?? 1)
};

function departmentFrom(transcript: string) {
  const lower = transcript.toLowerCase();
  return departmentNames.find((department) => lower.includes(department.toLowerCase())) ??
    (/(water|leak|washroom|building|door|light|air.?condition)/i.test(lower) ? 'Facilities' :
      /(server|computer|network|software|printer|login)/i.test(lower) ? 'IT' :
        /(machine|motor|conveyor|equipment|bearing|noise)/i.test(lower) ? 'Maintenance' : null);
}

function deadlineFrom(transcript: string, priority: Priority, now = new Date()) {
  const lower = transcript.toLowerCase();
  const relative = lower.match(/within\s+(\d+)\s*(minute|min|hour|hr|day)s?/);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2];
    const minutes = /min/.test(unit) ? amount : /day/.test(unit) ? amount * 1440 : amount * 60;
    return new Date(now.getTime() + minutes * 60_000);
  }
  if (/before lunch/.test(lower)) {
    const due = new Date(now); due.setHours(12, 0, 0, 0);
    if (due <= now) due.setDate(due.getDate() + 1);
    return due;
  }
  if (/before (the )?night shift/.test(lower)) {
    const due = new Date(now); due.setHours(21, 0, 0, 0);
    if (due <= now) due.setDate(due.getDate() + 1);
    return due;
  }
  if (/today|this afternoon|this evening/.test(lower)) {
    const due = new Date(now); due.setHours(18, 0, 0, 0);
    if (due <= now) due.setTime(now.getTime() + 60 * 60_000);
    return due;
  }
  if (/by tomorrow|tomorrow/.test(lower)) {
    const due = new Date(now); due.setDate(due.getDate() + 1); due.setHours(17, 0, 0, 0);
    return due;
  }
  const weekday = lower.match(/by\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/);
  if (weekday) {
    const dayIndex: Record<string, number> = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
    const due = new Date(now); const target = dayIndex[weekday[1]!]!;
    let days = (target - due.getDay() + 7) % 7;
    if (days === 0) days = 7;
    due.setDate(due.getDate() + days); due.setHours(17, 0, 0, 0);
    return due;
  }
  return new Date(now.getTime() + slaHours[priority] * 60 * 60_000);
}

function priorityFrom(transcript: string): Priority | null {
  const lower = transcript.toLowerCase();
  if (classifySafety(transcript).emergency) return 'CRITICAL';
  if (/(stopped|shutdown|not working|urgent|strange noise|abnormal noise|leaking|overflow|बंद|काम नहीं|तेज आवाज|अजीब आवाज|रिसाव|செயல்படவில்லை|நின்றுவிட்டது|அதிக சத்தம்|கசிவு)/iu.test(lower)) return 'HIGH';
  if (/(minor|cosmetic|low priority)/i.test(lower)) return 'LOW';
  return null;
}

function deadlineNeedsConfirmation(transcript: string, language: string) {
  const lower = transcript.toLocaleLowerCase();
  // These are the phrases currently handled deterministically by deadlineFrom.
  const deterministic = /\bwithin\s+\d+\s*(?:minute|min|hour|hr|day)s?\b|\bbefore\s+(?:the\s+)?(?:lunch|night shift)\b|\b(?:today|this afternoon|this evening|by tomorrow|tomorrow)\b|\bby\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/iu;
  if (language === 'hi' || language === 'hinglish') {
    // “kal” can mean either yesterday or tomorrow; ask the reporter to confirm it.
    if (/\bkal\b|कल/u.test(lower)) return true;
  }
  return !deterministic.test(lower);
}

function actionNeedsConfirmation(transcript: string) {
  return !/(?:\bplease\b|\bkindly\b|\bneed(?:s)? to\b|\bshould\b|\bmust\b|\bcheck\b|\binspect\b|\brepair\b|\bfix\b|\breplace\b|\bstop\b|\binform\b|\btell\b|\bnotify\b|\bcheck(?:ed)?\b|ठीक करें|जांचें|जाँचें|बताएं|करवा(?:एं|ना)?|देखें|சரிசெய்|சரிபார்க்க|தெரிவிக்க|பார்க்கவும்|நிறுத்து)/iu.test(transcript);
}

function mockExtraction(transcript: string, language = 'hi'): IncidentExtraction {
  const trimmed = transcript.trim();
  const priority = priorityFrom(trimmed) ?? 'MEDIUM';
  const asset = trimmed.match(/\b(machine\s*\d+|server(?: room)?|conveyor\s*\d+|pump\s*\d+)\b/i)?.[0] ?? null;
  const location = trimmed.match(/(?:near|at|in|on)\s+(?:the\s+)?([^,.!?]{3,80})/i)?.[1]?.trim() ?? null;
  const department = departmentFrom(trimmed);
  const vague = /(something is wrong|that machine over there|over there|the thing is broken)/i.test(trimmed);
  const confidence = vague || (trimmed.length < 45 && !asset && !location) ? 0.35 : department && (asset || location) ? 0.91 : department ? 0.76 : 0.48;
  const missingInformation = [
    ...(!department ? ['responsible department'] : []),
    ...(!location ? ['location'] : []),
    ...(!asset && trimmed.length < 30 ? ['asset or issue details'] : []),
    ...(deadlineNeedsConfirmation(trimmed, language) ? ['deadline'] : []),
    ...(actionNeedsConfirmation(trimmed) ? ['requested action'] : [])
  ];
  const firstSentence = trimmed.split(/[.!?]/, 1)[0] ?? trimmed;
  return extractionSchema.parse({
    title: firstSentence.slice(0, 140) || 'Operational issue reported',
    description: trimmed,
    abnormality: trimmed || null,
    asset,
    location,
    responsibleDepartment: department,
    responsiblePerson: null,
    priority,
    deadline: deadlineFrom(trimmed, priority).toISOString(),
    requestedAction: `Investigate and resolve: ${firstSentence}`.slice(0, 500),
    confidence,
    missingInformation,
    requiresConfirmation: confidence < 0.65 || !department || deadlineNeedsConfirmation(trimmed, language) || actionNeedsConfirmation(trimmed)
  });
}

function extractionInstructions(language: string) {
  return `Extract one workplace incident from the reporter's transcript. The selected language is ${language}. Preserve code-switching and operational terms; do not translate or rewrite the source transcript in the description. Return only these fields: title, description, abnormality, asset, location, responsibleDepartment, responsiblePerson, priority, deadline, requestedAction, confidence, missingInformation, requiresConfirmation. Use null for unknown nullable fields. Do not invent an employee, department, asset, location, requested action, or deadline. Use only details stated or strongly implied by the transcript. When responsibility or any material field is unclear, add it to missingInformation and set requiresConfirmation=true. If no deadline is stated, use a provisional priority SLA (LOW 48h, MEDIUM 24h, HIGH 8h, CRITICAL 1h), add "deadline" to missingInformation, and require reporter confirmation before work is assigned. Hindi "kal" is ambiguous and requires confirmation. If the reporter did not request an action, set requestedAction to "Confirm the appropriate action" and add "requested action" to missingInformation. Priority must be LOW, MEDIUM, HIGH, or CRITICAL. Treat confidence as a rough model estimate, not a calibrated probability. The backend applies deterministic safety and schema checks after your response.`;
}

async function openAiExtraction(transcript: string, language: string): Promise<IncidentExtraction> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is required when MOCK_AI=false');
  const model = process.env.OPENAI_MODEL ?? 'gpt-4o-mini';
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: extractionInstructions(language) },
            { role: 'user', content: `Source transcript (preserve its language and meaning):\n${transcript}` }
          ]
        })
      });
      if (!response.ok) throw new Error(`OpenAI extraction failed with ${response.status}`);
      const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const content = payload.choices?.[0]?.message?.content;
      if (!content) throw new Error('OpenAI returned no structured incident');
      return extractionSchema.parse(JSON.parse(content));
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Unable to extract incident');
}

async function ollamaExtraction(transcript: string, language: string): Promise<IncidentExtraction> {
  const baseUrl = (process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434').replace(/\/+$/u, '');
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(Number(process.env.LLM_TIMEOUT_MS ?? 120_000)),
    body: JSON.stringify({
      model: process.env.OLLAMA_MODEL ?? 'llama3.1:8b',
      stream: false,
      format: z.toJSONSchema(extractionSchema),
      options: { temperature: 0 },
      messages: [
        { role: 'system', content: extractionInstructions(language) },
        { role: 'user', content: `Source transcript (preserve its language and meaning):\n${transcript}` }
      ]
    })
  });
  if (!response.ok) throw new Error(`Local extraction provider failed with ${response.status}`);
  const payload = await response.json() as { message?: { content?: string } };
  const content = payload.message?.content;
  if (!content) throw new Error('Local extraction provider returned no structured incident');
  return extractionSchema.parse(JSON.parse(content));
}

function finalizeExtraction(transcript: string, value: IncidentExtraction, language: string) {
  const parsed = extractionSchema.parse(value);
  const priority = applyPriorityRules(transcript, parsed.priority);
  const missingInformation = [...new Set(parsed.missingInformation)];
  if (!parsed.responsibleDepartment && !missingInformation.includes('responsible department')) missingInformation.push('responsible department');
  if (deadlineNeedsConfirmation(transcript, language) && !missingInformation.includes('deadline')) missingInformation.push('deadline');
  if (actionNeedsConfirmation(transcript) && !missingInformation.includes('requested action')) missingInformation.push('requested action');
  return {
    ...parsed,
    priority,
    missingInformation,
    requiresConfirmation: parsed.requiresConfirmation || parsed.confidence < 0.65 || missingInformation.length > 0
  };
}

export async function extractIncident(transcript: string, language = 'hi') {
  if (!transcript.trim()) throw new Error('Cannot extract an incident from an empty transcript');
  const configuredProvider = process.env.LLM_PROVIDER === 'mock' && process.env.MOCK_AI === 'false'
    ? 'openai'
    : process.env.LLM_PROVIDER ?? (process.env.MOCK_AI === 'false' ? 'openai' : 'mock');
  const extraction = configuredProvider === 'ollama'
    ? await ollamaExtraction(transcript, language)
    : configuredProvider === 'openai'
      ? await openAiExtraction(transcript, language)
      : configuredProvider === 'mock'
        ? mockExtraction(transcript, language)
        : (() => { throw new Error(`Unsupported LLM_PROVIDER: ${configuredProvider}`); })();
  return finalizeExtraction(transcript, extraction, language);
}

export function applyPriorityRules(transcript: string, suggested: Priority): Priority {
  const rulePriority = priorityFrom(transcript);
  if (!rulePriority) return suggested;
  const rank: Priority[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
  return rank.indexOf(rulePriority) > rank.indexOf(suggested) ? rulePriority : suggested;
}

export const configuredExtractionProvider: IncidentExtractionProvider = { extract: extractIncident };
