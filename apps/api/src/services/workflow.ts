import type { DatabaseClient } from '../db.js';
import { randomUUID } from 'node:crypto';
import type { IncidentExtraction } from './extraction.js';
import { resolveResponsibility } from './responsibility.js';
import { sendNotification } from './email.js';

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
  const resolution = input.assignedEmployeeId
    ? await resolveExplicitAssignee(db, input.assignedEmployeeId, input.extraction.responsibleDepartment)
    : await resolveResponsibility(db, input.extraction.responsibleDepartment, input.extraction.responsiblePerson);

  if ((input.extraction.requiresConfirmation && !input.confirmed) || !resolution.employeeId) {
    await db.voiceReport.update({ where: { id: input.voiceReportId }, data: { status: 'NEEDS_CLARIFICATION' } });
    const options = 'options' in resolution ? resolution.options : [];
    throw new ClarificationRequired(input.extraction.requiresConfirmation ? input.extraction.missingInformation.length ? `Please confirm: ${input.extraction.missingInformation.join(', ')}.` : 'Please review and confirm the extracted report.' : resolution.reason, options);
  }

  const reporter = await db.employee.findUnique({ where: { id: input.reporterId } });
  const assignee = await db.employee.findUnique({ where: { id: resolution.employeeId } });
  if (!reporter || !assignee) throw new Error('Reporter or assignee no longer exists');

  const dueAt = new Date(input.extraction.deadline);
  if (!Number.isFinite(dueAt.getTime())) throw new Error('The incident deadline is invalid');
  const now = new Date();
  const department = resolution.department ? await db.department.findFirst({ where: { name: { equals: resolution.department, mode: 'insensitive' } } }) : null;
  const rules = await db.escalationRule.findMany({ where: { enabled: true, OR: [{ departmentId: null }, { departmentId: department?.id ?? '__none__' }] } });
  const matchingRule = rules.find((rule) => !rule.priority || rule.priority === input.extraction.priority);
  const reminderBeforeMinutes = matchingRule?.reminderBeforeMinutes ?? 60;
  const reminderAt = new Date(Math.max(now.getTime(), dueAt.getTime() - reminderBeforeMinutes * 60_000));
  const incidentNumber = `INC-${now.getUTCFullYear()}-${randomUUID().slice(0, 8).toUpperCase()}`;

  const created = await db.$transaction(async (tx) => {
    const incident = await tx.incident.create({ data: {
      incidentNumber,
      title: input.extraction.title,
      description: input.extraction.description,
      abnormality: input.extraction.abnormality,
      asset: input.extraction.asset,
      location: input.extraction.location,
      requestedAction: input.extraction.requestedAction,
      responsibleDepartment: resolution.department,
      responsiblePerson: assignee.name,
      priority: input.extraction.priority,
      status: 'OPEN',
      confidence: input.extraction.confidence,
      extractedData: input.extraction,
      missingInformation: input.extraction.missingInformation,
      requiresConfirmation: false,
      deadline: dueAt,
      reporterId: reporter.id,
      voiceReportId: input.voiceReportId
    } });
    const task = await tx.task.create({ data: {
      title: input.extraction.requestedAction,
      description: input.extraction.description,
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
    await tx.reminder.create({ data: { taskId: task.id, scheduledAt: reminderAt, status: 'PENDING' } });
    await tx.voiceReport.update({ where: { id: input.voiceReportId }, data: { status: 'PROCESSED' } });
    await tx.auditLog.createMany({ data: [
      { actorId: reporter.id, incidentId: incident.id, action: 'INCIDENT_CREATED', reason: 'Created from the confirmed voice report.', metadata: { voiceReportId: input.voiceReportId } },
      { actorId: input.actorId ?? reporter.id, incidentId: incident.id, action: 'INCIDENT_ASSIGNED', reason: resolution.reason, metadata: { assigneeId: assignee.id, department: resolution.department } },
      { actorId: reporter.id, incidentId: incident.id, action: 'TASK_CREATED', reason: 'Deadline derived from the transcript or configured priority SLA.', metadata: { taskId: task.id, deadline: dueAt.toISOString(), reminderAt: reminderAt.toISOString() } }
    ] });
    return { incident, task, assignee };
  });

  await sendNotification(db, {
    kind: 'ASSIGNMENT', to: created.assignee.email, recipientId: created.assignee.id,
    subject: `Action required: ${created.incident.incidentNumber} ${created.incident.title}`,
    body: `${created.incident.description}\n\nLocation: ${created.incident.location ?? 'Not provided'}\nPriority: ${created.incident.priority}\nDeadline: ${dueAt.toLocaleString()}\n\nPlease review the task in VoiceBridge.`,
    incidentId: created.incident.id, taskId: created.task.id
  });
  await sendNotification(db, {
    kind: 'REPORTER_UPDATE', to: reporter.email, recipientId: reporter.id,
    subject: `Your report ${created.incident.incidentNumber} has been assigned`,
    body: `Your report “${created.incident.title}” has been assigned to ${created.assignee.name} in ${resolution.department}. You can track its status in VoiceBridge.`,
    incidentId: created.incident.id, taskId: created.task.id
  });
  await db.auditLog.createMany({ data: [
    { actorId: null, incidentId: created.incident.id, action: 'EMAIL_SENT', reason: 'Assignment notification queued through the configured email provider.', metadata: { recipient: created.assignee.email } },
    { actorId: null, incidentId: created.incident.id, action: 'REPORTER_NOTIFIED', reason: 'The reporter received an assignment status update.', metadata: { recipient: reporter.email } }
  ] });
  return { ...created, resolution };
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
