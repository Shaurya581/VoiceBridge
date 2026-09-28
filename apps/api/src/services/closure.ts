import type { DatabaseClient } from '../db.js';
import { sendNotification } from './email.js';
import { ivrProvider, normalizeLanguage, speakStatus } from './voice-feedback.js';
import { canTransitionIncident } from './safety.js';

export async function completeTaskForVerification(db: DatabaseClient, taskId: string, actorId: string) {
  const task = await db.task.findUnique({ where: { id: taskId }, include: { incident: { include: { voiceReports: { orderBy: { createdAt: 'asc' }, take: 1 } } } } });
  if (!task) throw new Error('Task not found');
  if (!['OPEN', 'IN_PROGRESS', 'OVERDUE', 'ESCALATED'].includes(task.status)) throw new Error(`Cannot complete a task in ${task.status}.`);
  if (!canTransitionIncident(task.incident.status, 'REPORTER_VERIFICATION_PENDING')) throw new Error(`Cannot verify completion from incident state ${task.incident.status}.`);
  const reporter = await db.employee.findUnique({ where: { id: task.incident.reporterId } });
  if (!reporter) throw new Error('Original reporter no longer exists');
  const previousAttempts = await db.closureVerification.count({ where: { incidentId: task.incidentId } });
  const completed = await db.$transaction(async (tx) => {
    const updatedTask = await tx.task.update({ where: { id: task.id }, data: { status: 'COMPLETED', completedAt: new Date() } });
    await tx.incident.update({ where: { id: task.incidentId }, data: { status: 'REPORTER_VERIFICATION_PENDING', reporterVerificationStatus: 'PENDING' } });
    await tx.voiceReport.updateMany({ where: { incidentId: task.incidentId }, data: { status: 'REPORTER_VERIFICATION_PENDING' } });
    const verification = await tx.closureVerification.create({ data: { incidentId: task.incidentId, reporterId: reporter.id, attemptNumber: previousAttempts + 1 } });
    await tx.auditLog.create({ data: { actorId, incidentId: task.incidentId, action: 'TASK_COMPLETED_BY_ASSIGNEE', reason: 'Task completion is awaiting confirmation from the original reporter.', metadata: { taskId: task.id, verificationId: verification.id } } });
    return { task: updatedTask, verification };
  });
  const language = task.incident.voiceReports[0]?.language ?? 'hi';
  const prompt = 'Your reported issue has been marked as resolved. Press 1 if the problem is fixed. Press 2 if the problem still exists.';
  await speakStatus({ text: prompt, language, recipientId: reporter.id, kind: 'CLOSURE_VERIFICATION_PROMPT' });
  const call = await ivrProvider().call({ recipientId: reporter.id, language: normalizeLanguage(language), prompt, kind: 'CLOSURE_VERIFICATION' });
  await db.auditLog.create({ data: { actorId: null, incidentId: task.incidentId, action: 'REPORTER_VERIFICATION_REQUESTED', reason: 'Mock IVR provider recorded the closure verification call request.', metadata: { verificationId: completed.verification.id, deliveryStatus: call.status } } });
  const immediateVerification = call.response ? await recordReporterVerification(db, task.incidentId, reporter.id, call.response) : null;
  return { ...completed, incidentStatus: immediateVerification?.status ?? 'REPORTER_VERIFICATION_PENDING' };
}

export async function recordReporterVerification(db: DatabaseClient, incidentId: string, reporterId: string, response: '1' | '2', evidenceRef?: string) {
  const incident = await db.incident.findUnique({ where: { id: incidentId }, include: { tasks: { include: { assignee: true } } } });
  if (!incident) throw new Error('Incident not found');
  if (incident.reporterId !== reporterId) throw new Error('Only the original reporter can verify closure');
  if (incident.status !== 'REPORTER_VERIFICATION_PENDING') throw new Error('This incident is not awaiting reporter verification');
  if (!canTransitionIncident(incident.status, response === '1' ? 'REPORTER_CONFIRMED' : 'REPORTER_REJECTED')) throw new Error('Invalid reporter verification transition');
  const verification = await db.closureVerification.findFirst({ where: { incidentId, reporterId, status: 'PENDING' }, orderBy: { attemptNumber: 'desc' } });
  if (!verification) throw new Error('No pending closure verification was found');
  const confirmed = response === '1';
  await db.$transaction(async (tx) => {
    await tx.closureVerification.update({ where: { id: verification.id }, data: { status: confirmed ? 'CONFIRMED' : 'REJECTED', response, evidenceRef, respondedAt: new Date() } });
    await tx.incident.update({ where: { id: incidentId }, data: { status: confirmed ? 'REPORTER_CONFIRMED' : 'REPORTER_REJECTED', reporterVerificationStatus: confirmed ? 'CONFIRMED' : 'REJECTED' } });
    await tx.incident.update({ where: { id: incidentId }, data: confirmed
      ? { status: 'CLOSED', reporterVerifiedAt: new Date() }
      : { status: 'REOPENED', reopenedAt: new Date(), reopenReason: 'Original reporter said the issue is still present.' } });
    await tx.voiceReport.updateMany({ where: { incidentId }, data: { status: confirmed ? 'CLOSED' : 'REOPENED' } });
    if (!confirmed) await tx.task.updateMany({ where: { incidentId }, data: { status: 'OPEN', completedAt: null } });
    await tx.auditLog.createMany({ data: [
      { actorId: reporterId, incidentId, action: confirmed ? 'REPORTER_CONFIRMED' : 'REPORTER_REJECTED', reason: confirmed ? 'Reporter confirmed the issue is fixed.' : 'Reporter reported that the issue remains.' },
      ...(!confirmed ? [{ actorId: reporterId, incidentId, action: 'INCIDENT_REOPENED', reason: 'Reopened after reporter rejected closure.' }] : [])
    ] });
  });
  await speakStatus({ text: confirmed ? 'Thank you. Your report is now closed.' : 'Thank you. Your report has been reopened and the responsible team will be notified.', language: (await db.voiceReport.findFirst({ where: { incidentId }, orderBy: { createdAt: 'asc' } }))?.language ?? 'hi', recipientId: reporterId, kind: 'FINAL_STATUS' });
  if (!confirmed) {
    const assignee = incident.tasks[0]?.assignee;
    if (assignee) await sendNotification(db, { kind: 'REOPENED', to: assignee.email, recipientId: assignee.id, subject: `Reopened: ${incident.incidentNumber}`, body: `The original reporter said the issue is still present. Please investigate again.`, incidentId, taskId: incident.tasks[0]?.id });
  }
  return { status: confirmed ? 'CLOSED' : 'REOPENED', verificationId: verification.id };
}
