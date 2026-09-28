import type { Priority } from '../generated/prisma/enums.js';

const defaultEmergencyTerms = [
  'fire', 'smoke', 'gas leak', 'serious injury', 'severe injury', 'electric shock', 'electrocution', 'chemical leak', 'major chemical', 'toxic spill', 'explosion',
  'aag', 'dhua', 'gas risav', 'gambhir chot', 'bijli ka jhatka', 'rasayanik risav',
  'आग', 'धुआँ', 'धुआ', 'गैस रिसाव', 'गंभीर चोट', 'बिजली का झटका', 'रासायनिक रिसाव', 'विस्फोट',
  'தீ', 'புகை', 'வாயு கசிவு', 'கடுமையான காயம்', 'மின்சார அதிர்ச்சி', 'மின்சாரம் தாக்கியது', 'இரசாயன கசிவு', 'வெடிப்பு'
];

export function classifySafety(transcript: string): { emergency: boolean; priority: Priority; reason: string | null } {
  const terms = [...defaultEmergencyTerms, ...(process.env.EMERGENCY_TERMS ?? '').split('|')].map((term) => term.trim()).filter(Boolean);
  const escaped = terms.map((term) => {
    const safe = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return /^[\x00-\x7F]+$/.test(term) ? `\\b${safe}\\b` : safe;
  });
  const match = transcript.match(new RegExp(`(${escaped.join('|')})`, 'i'));
  return match
    ? { emergency: true, priority: 'CRITICAL', reason: `Deterministic safety rule matched: ${match[0]}.` }
    : { emergency: false, priority: 'MEDIUM', reason: null };
}

export const incidentTransitions = {
  OPEN: ['IN_PROGRESS', 'COMPLETED', 'OVERDUE', 'ESCALATED', 'EMERGENCY', 'AWAITING_CONFIRMATION', 'REPORTER_VERIFICATION_PENDING'],
  IN_PROGRESS: ['COMPLETED', 'OVERDUE', 'ESCALATED', 'EMERGENCY', 'REPORTER_VERIFICATION_PENDING'],
  OVERDUE: ['IN_PROGRESS', 'COMPLETED', 'ESCALATED', 'EMERGENCY', 'REPORTER_VERIFICATION_PENDING'],
  ESCALATED: ['IN_PROGRESS', 'COMPLETED', 'EMERGENCY', 'REPORTER_VERIFICATION_PENDING'],
  COMPLETED: ['REPORTER_VERIFICATION_PENDING'],
  COMPLETED_BY_ASSIGNEE: ['REPORTER_VERIFICATION_PENDING'],
  REPORTER_VERIFICATION_PENDING: ['REPORTER_CONFIRMED', 'REPORTER_REJECTED'],
  REPORTER_REJECTED: ['REOPENED'],
  REOPENED: ['IN_PROGRESS', 'COMPLETED', 'OVERDUE', 'ESCALATED', 'EMERGENCY', 'REPORTER_VERIFICATION_PENDING'],
  REPORTER_CONFIRMED: ['CLOSED'],
  EMERGENCY: ['IN_PROGRESS', 'COMPLETED', 'REPORTER_VERIFICATION_PENDING', 'ESCALATED'],
  AWAITING_CONFIRMATION: ['OPEN', 'EMERGENCY'],
  CLOSED: [],
  ASSIGNED: ['IN_PROGRESS', 'EMERGENCY']
} as const;

export function canTransitionIncident(from: string, to: string) {
  return (incidentTransitions as Record<string, readonly string[]>)[from]?.includes(to) ?? false;
}
