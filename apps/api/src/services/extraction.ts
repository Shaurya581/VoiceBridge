import { z } from 'zod';
import type { Priority } from '../generated/prisma/enums.js';

export const extractionSchema = z.object({
  title: z.string().min(3).max(160),
  description: z.string().min(3).max(4000),
  abnormality: z.string().max(500).nullable(),
  asset: z.string().max(200).nullable(),
  location: z.string().max(300).nullable(),
  responsibleDepartment: z.string().max(100).nullable(),
  responsiblePerson: z.string().max(160).nullable(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  deadline: z.string().datetime(),
  requestedAction: z.string().max(500),
  confidence: z.number().min(0).max(1),
  missingInformation: z.array(z.string().max(160)).max(12),
  requiresConfirmation: z.boolean()
});

export type IncidentExtraction = z.infer<typeof extractionSchema>;

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

function priorityFrom(transcript: string): Priority {
  const lower = transcript.toLowerCase();
  if (/(exposed electrical|electric shock|fire|smoke|injur|dangerous|safety hazard|gas leak)/i.test(lower)) return 'CRITICAL';
  if (/(stopped|shutdown|not working|urgent|strange noise|abnormal noise|leaking|overflow)/i.test(lower)) return 'HIGH';
  if (/(minor|cosmetic|low priority)/i.test(lower)) return 'LOW';
  return 'MEDIUM';
}

function mockExtraction(transcript: string): IncidentExtraction {
  const trimmed = transcript.trim();
  const priority = priorityFrom(trimmed);
  const asset = trimmed.match(/\b(machine\s*\d+|server(?: room)?|conveyor\s*\d+|pump\s*\d+)\b/i)?.[0] ?? null;
  const location = trimmed.match(/(?:near|at|in|on)\s+(?:the\s+)?([^,.!?]{3,80})/i)?.[1]?.trim() ?? null;
  const department = departmentFrom(trimmed);
  const vague = /(something is wrong|that machine over there|over there|the thing is broken)/i.test(trimmed);
  const confidence = vague || (trimmed.length < 45 && !asset && !location) ? 0.35 : department && (asset || location) ? 0.91 : department ? 0.76 : 0.48;
  const missingInformation = [
    ...(!department ? ['responsible department'] : []),
    ...(!location ? ['location'] : []),
    ...(!asset && trimmed.length < 30 ? ['asset or issue details'] : [])
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
    requiresConfirmation: confidence < 0.65 || !department
  });
}

async function openAiExtraction(transcript: string): Promise<IncidentExtraction> {
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
            { role: 'system', content: `Extract an operational incident as JSON with keys title, description, abnormality, asset, location, responsibleDepartment, responsiblePerson, priority, deadline, requestedAction, confidence, missingInformation, requiresConfirmation. Never invent a person or deadline. Use ISO 8601 deadline; if absent, use a priority SLA from now (LOW 48h, MEDIUM 24h, HIGH 8h, CRITICAL 1h). If information is uncertain, lower confidence and require confirmation. Priority must be LOW, MEDIUM, HIGH, or CRITICAL.` },
            { role: 'user', content: transcript }
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

export async function extractIncident(transcript: string) {
  const extraction = process.env.MOCK_AI !== 'false' ? mockExtraction(transcript) : await openAiExtraction(transcript);
  const priority = applyPriorityRules(transcript, extraction.priority);
  return { ...extraction, priority, requiresConfirmation: extraction.requiresConfirmation || extraction.confidence < 0.65 };
}

export function applyPriorityRules(transcript: string, suggested: Priority): Priority {
  const rulePriority = priorityFrom(transcript);
  const rank: Priority[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
  return rank.indexOf(rulePriority) > rank.indexOf(suggested) ? rulePriority : suggested;
}
