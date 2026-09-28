import type { DatabaseClient } from '../db.js';
import { randomUUID } from 'node:crypto';
import type { IncidentExtraction } from './extraction.js';
import { resolveResponsibility } from './responsibility.js';
import { sendNotification } from './email.js';
import { classifySafety } from './safety.js';
import { speakStatus } from './voice-feedback.js';
import { dispatchEmergencyAlert } from './emergency-alerts.js';
import { isValidDeadline, selectEscalationPolicy } from './workflow-policy.js';

export class ClarificationRequired extends Error {
  constructor(message: string, readonly options: Array<{ id: string; name: string; email: string; role: string }> = []) {
    super(message);
  }
}

export async function createIncidentWorkflow(db: DatabaseClient, input: {
  reporterId: string;
  voiceReportId: string;
  extraction: IncidentExtraction;
  assignedEmployeeId?: string;
  actorId?: string;
  confirmed?: boolean;
}) {
  const reporter = await db.employee.findUnique({ where: { id: input.reporterId } });
  if (!reporter) throw new Error('Reporter no longer exists');
  const report = await db.voiceReport.findUnique({ where: { id: input.voiceReportId }, select: { transcript: true, language: true } });
  const safety = classifySafety(report?.transcript ?? input.extraction.description);
  const extraction = safety.emergency ? { ...input.extraction, priority: 'CRITICAL' as const } : input.extraction;
  await db.voiceReport.update({ where: { id: input.voiceReportId }, data: { status: safety.emergency ? 'EMERGENCY' : 'DUPLICATE_CHECK' } });
  let emergencyContact = safety.emergency
    ? await db.employee.findFirst({ where: { isActive: true, ...(process.env.EMERGENCY_CONTACT_EMAIL ? { email: process.env.EMERGENCY_CONTACT_EMAIL } : { role: { in: ['MANAGER', 'ADMIN'] } }) }, orderBy: { role: 'desc' } })
    : null;
  if (!safety.emergency && extraction.asset) {
    const recent = await db.incident.findMany({
      where: { asset: { equals: extraction.asset, mode: 'insensitive' }, createdAt: { gte: new Date(Date.now() - Number(process.env.DUPLICATE_WINDOW_MINUTES ?? 60) * 60_000) }, status: { in: ['OPEN', 'IN_PROGRESS', 'OVERDUE', 'ESCALATED'] } },
      include: { tasks: { include: { assignee: true } } }, orderBy: { createdAt: 'desc' }, take: 20
    });
    const duplicate = recent.find((candidate) => issueSimilarity(candidate.abnormality ?? candidate.title, extraction.abnormality ?? extraction.description) >= Number(process.env.DUPLICATE_AUTO_MERGE_THRESHOLD ?? 0.9));
    if (duplicate) {
      await db.$transaction(async (tx) => {
        await tx.voiceReport.update({ where: { id: input.voiceReportId }, data: { incidentId: duplicate.id, status: 'ASSIGNED' } });
        await tx.auditLog.create({ data: { actorId: reporter.id, incidentId: duplicate.id, action: 'VOICE_REPORT_MERGED', reason: 'High-confidence asset and issue match within the configured time window.', metadata: { voiceReportId: input.voiceReportId, confidence: issueSimilarity(duplicate.abnormality ?? duplicate.title, extraction.abnormality ?? extraction.description) } } });
      });
      await speakStatus({ text: `Your report has been added as supporting information to incident ${duplicate.incidentNumber}.`, language: report?.language ?? null, recipientId: reporter.id, kind: 'DUPLICATE_ACKNOWLEDGEMENT' });
      return { incident: duplicate, task: duplicate.tasks[0] ?? null, assignee: duplicate.tasks[0]?.assignee ?? null, resolution: { employeeId: duplicate.tasks[0]?.assigneeId ?? null, department: duplicate.responsibleDepartment, reason: 'Attached as a supporting report to a recent matching incident.', confidence: 1 }, duplicate: true };
    }
  }
  if (!safety.emergency) await db.voiceReport.update({ where: { id: input.voiceReportId }, data: { status: 'ASSIGNMENT_PENDING' } });
  let resolution = input.assignedEmployeeId
    ? await resolveExplicitAssignee(db, input.assignedEmployeeId, extraction.responsibleDepartment)
    : await resolveResponsibility(db, extraction.responsibleDepartment, extraction.responsiblePerson);

  if (safety.emergency && !emergencyContact) {
    const safetyContact = await db.employee.findFirst({ where: { isActive: true, role: { in: ['MANAGER', 'ADMIN'] } }, orderBy: { role: 'desc' } });
    if (safetyContact) {
      emergencyContact = safetyContact;
      if (!resolution.employeeId) resolution = { employeeId: safetyContact.id, department: 'Safety / Operations', reason: 'Immediate emergency fallback contact selected by configured safety policy.', confidence: 1 };
    }
  }

  if ((!safety.emergency && extraction.requiresConfirmation && !input.confirmed) || !resolution.employeeId) {
    await db.voiceReport.update({ where: { id: input.voiceReportId }, data: { status: 'NEEDS_CLARIFICATION' } });
    const options = 'options' in resolution ? resolution.options : [];
    throw new ClarificationRequired(!safety.emergency && extraction.requiresConfirmation ? extraction.missingInformation.length ? `Please confirm: ${extraction.missingInformation.join(', ')}.` : 'Please review and confirm the extracted report.' : resolution.reason, options);
  }

  const assignee = await db.employee.findUnique({ where: { id: resolution.employeeId } });
  if (!assignee) throw new Error('Assignee no longer exists');

  const dueAt = new Date(extraction.deadline);
  if (!isValidDeadline(dueAt)) throw new Error('The incident deadline is invalid');
  const now = new Date();
  const department = resolution.department ? await db.department.findFirst({ where: { name: { equals: resolution.department, mode: 'insensitive' } } }) : null;
  const rules = safety.emergency ? [] : await db.escalationRule.findMany({ where: { enabled: true, OR: [{ departmentId: null }, { departmentId: department?.id ?? '__none__' }] }, include: { department: true } });
  const matchingRule = selectEscalationPolicy(rules, resolution.department, extraction.priority);
  const reminderBeforeMinutes = matchingRule?.reminderBeforeMinutes ?? 60;
  const reminderAt = new Date(Math.max(now.getTime(), dueAt.getTime() - reminderBeforeMinutes * 60_000));
  const incidentNumber = `INC-${now.getUTCFullYear()}-${randomUUID().slice(0, 8).toUpperCase()}`;

  let duplicateReviewPending = false;
  const created = await db.$transaction(async (tx) => {
    const incident = await tx.incident.create({ data: {
      incidentNumber,
      title: input.extraction.title,
      description: input.extraction.description,
      abnormality: extraction.abnormality,
      asset: extraction.asset,
      location: extraction.location,
      requestedAction: extraction.requestedAction,
      responsibleDepartment: resolution.department,
      responsiblePerson: assignee.name,
      priority: extraction.priority,
      status: safety.emergency ? 'EMERGENCY' : 'OPEN',
      isEmergency: safety.emergency,
      emergencyStatus: safety.emergency ? 'ALERT_PENDING' : null,
      confidence: extraction.confidence,
      extractedData: extraction,
      missingInformation: extraction.missingInformation,
      requiresConfirmation: false,
      deadline: dueAt,
      reporterId: reporter.id,
      voiceReports: { connect: { id: input.voiceReportId } }
    } });
    const task = await tx.task.create({ data: {
      title: extraction.requestedAction,
      description: extraction.description,
      status: 'OPEN',
      deadline: dueAt,
      incidentId: incident.id,
      assigneeId: assignee.id,
      createdById: reporter.id
    } });
    await tx.assignment.create({ data: {
      taskId: task.id,
      employeeId: assignee.id,
      reason: resolution.reason,
      confidence: resolution.confidence,
      assignedById: input.actorId ?? reporter.id
    } });
    if (!safety.emergency) await tx.reminder.create({ data: { taskId: task.id, scheduledAt: reminderAt, status: 'PENDING' } });
    await tx.voiceReport.update({ where: { id: input.voiceReportId }, data: { status: safety.emergency ? 'EMERGENCY' : 'ASSIGNED', incidentId: incident.id } });
    const emergencyEvent = safety.emergency ? await tx.emergencyEvent.create({ data: { incidentId: incident.id, kind: 'IMMEDIATE_ALERT', status: 'PENDING', reason: safety.reason ?? 'Configured safety rule matched.', responseDeadline: new Date(now.getTime() + Number(process.env.EMERGENCY_RESPONSE_MINUTES ?? 15) * 60_000), metadata: { contactId: emergencyContact?.id ?? null } } }) : null;
    await tx.auditLog.createMany({ data: [
      { actorId: reporter.id, incidentId: incident.id, action: 'INCIDENT_CREATED', reason: 'Created from the confirmed voice report.', metadata: { voiceReportId: input.voiceReportId } },
      { actorId: input.actorId ?? reporter.id, incidentId: incident.id, action: 'INCIDENT_ASSIGNED', reason: resolution.reason, metadata: { assigneeId: assignee.id, department: resolution.department } },
      { actorId: reporter.id, incidentId: incident.id, action: 'TASK_CREATED', reason: safety.emergency ? 'Emergency task created; normal reminder cycle bypassed.' : 'Deadline derived from the transcript or configured priority SLA.', metadata: { taskId: task.id, deadline: dueAt.toISOString(), reminderAt: safety.emergency ? null : reminderAt.toISOString() } }
    ] });
    return { incident, task, assignee, emergencyEvent };
  });

  if (!safety.emergency && extraction.asset) {
    const possible = await db.incident.findMany({ where: {
      id: { not: created.incident.id },
      OR: [
        { asset: { equals: extraction.asset, mode: 'insensitive' } },
        ...(extraction.location ? [{ location: { equals: extraction.location, mode: 'insensitive' as const } }] : [])
      ],
      createdAt: { gte: new Date(Date.now() - Number(process.env.DUPLICATE_WINDOW_MINUTES ?? 60) * 60_000) }
    }, take: 20 });
    const candidate = possible.map((incident) => ({
      incident,
      confidence: Math.min(1, issueSimilarity(incident.abnormality ?? incident.title, extraction.abnormality ?? extraction.description) * 0.6 +
        (incident.asset?.toLowerCase() === extraction.asset?.toLowerCase() ? 0.4 : incident.location?.toLowerCase() === extraction.location?.toLowerCase() ? 0.2 : 0))
    })).sort((a, b) => b.confidence - a.confidence)[0];
    if (candidate && candidate.confidence >= Number(process.env.DUPLICATE_REVIEW_THRESHOLD ?? 0.6)) {
      duplicateReviewPending = true;
      await db.duplicateReview.create({ data: { candidateId: created.incident.id, existingIncidentId: candidate.incident.id, confidence: candidate.confidence, reason: 'Possible duplicate based on asset/location, issue similarity, and recent time window; manager review required.' } });
      await db.incident.update({ where: { id: created.incident.id }, data: { status: 'AWAITING_CONFIRMATION', requiresConfirmation: true } });
      await db.voiceReport.updateMany({ where: { incidentId: created.incident.id }, data: { status: 'AWAITING_CONFIRMATION' } });
      await db.auditLog.create({ data: { actorId: null, incidentId: created.incident.id, action: 'DUPLICATE_REVIEW_REQUESTED', reason: 'Uncertain duplicate match was queued for manager review.', metadata: { existingIncidentId: candidate.incident.id, confidence: candidate.confidence } } });
      const manager = await db.employee.findFirst({ where: { isActive: true, role: { in: ['MANAGER', 'ADMIN'] }, OR: [{ id: created.assignee.managerId ?? '__none__' }, { role: 'ADMIN' }] } });
      if (manager) await sendNotification(db, { kind: 'DUPLICATE_REVIEW', to: manager.email, recipientId: manager.id, subject: `Review possible duplicate: ${created.incident.incidentNumber}`, body: `Compare ${created.incident.incidentNumber} with ${candidate.incident.incidentNumber}. A decision is required before the candidate is assigned.`, incidentId: created.incident.id });
    }
  }

  const acknowledgement = speakStatus({ text: safety.emergency ? 'Emergency report received. Help is being contacted.' : 'Your report was received and is being processed.', language: report?.language ?? null, recipientId: reporter.id, kind: safety.emergency ? 'EMERGENCY_ACKNOWLEDGEMENT' : 'REPORT_ACKNOWLEDGEMENT' }).catch((error: unknown) => {
    console.error(JSON.stringify({ event: 'spoken_acknowledgement_failed', incidentId: created.incident.id, message: error instanceof Error ? error.message : 'unknown error' }));
  });
  if (safety.emergency) {
    if (created.emergencyEvent) await dispatchEmergencyAlert(db, created.emergencyEvent.id);
  }
  await acknowledgement;
  if (!duplicateReviewPending) await sendNotification(db, {
    kind: 'ASSIGNMENT', to: created.assignee.email, recipientId: created.assignee.id,
    subject: `${safety.emergency ? 'EMERGENCY: ' : ''}Action required: ${created.incident.incidentNumber} ${created.incident.title}`,
    body: `${created.incident.description}\n\nLocation: ${created.incident.location ?? 'Not provided'}\nPriority: ${created.incident.priority}\nDeadline: ${dueAt.toLocaleString()}\n\nPlease review the task in VoiceBridge.`,
    incidentId: created.incident.id, taskId: created.task.id
  });
  if (!duplicateReviewPending) await sendNotification(db, {
    kind: 'REPORTER_UPDATE', to: reporter.email, recipientId: reporter.id,
    subject: `Your report ${created.incident.incidentNumber} has been assigned`,
    body: `Your report “${created.incident.title}” has been assigned to ${created.assignee.name} in ${resolution.department}. You can track its status in VoiceBridge.`,
    incidentId: created.incident.id, taskId: created.task.id
  });
  if (!duplicateReviewPending) await db.auditLog.createMany({ data: [
    { actorId: null, incidentId: created.incident.id, action: 'EMAIL_SENT', reason: 'Assignment notification queued through the configured email provider.', metadata: { recipient: created.assignee.email } },
    { actorId: null, incidentId: created.incident.id, action: 'REPORTER_NOTIFIED', reason: 'The reporter received an assignment status update.', metadata: { recipient: reporter.email } }
  ] });
  return { ...created, incident: duplicateReviewPending ? { ...created.incident, status: 'AWAITING_CONFIRMATION' as const, requiresConfirmation: true } : created.incident, resolution, duplicateReviewPending };
}

function issueSimilarity(left: string, right: string) {
  const terms = (value: string) => new Set(value.toLowerCase().match(/[a-z0-9\p{L}]+/gu)?.filter((word) => word.length > 2) ?? []);
  const a = terms(left); const b = terms(right);
  if (!a.size || !b.size) return 0;
  const intersection = [...a].filter((word) => b.has(word)).length;
  const union = new Set([...a, ...b]).size;
  return intersection / union;
}

async function resolveExplicitAssignee(db: DatabaseClient, employeeId: string, departmentName: string | null) {
  const employee = await db.employee.findFirst({ where: { id: employeeId, isActive: true }, include: { department: true } });
  if (!employee) throw new ClarificationRequired('Choose an active employee from the directory.');
  return {
    employeeId: employee.id,
    department: employee.department?.name ?? departmentName ?? 'Unassigned',
    reason: 'The reporter or manager confirmed this assignee.',
    confidence: 1
  };
}
