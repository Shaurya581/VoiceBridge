import type { DatabaseClient } from '../db.js';
import { sendNotification } from './email.js';
import { canTransitionIncident } from './safety.js';
import { ivrProvider, normalizeLanguage, textToSpeechProvider, type IVRProvider, type TTSProvider } from './voice-feedback.js';
import type { WorkflowStatus } from '../generated/prisma/enums.js';

type ClosureFeedbackProviders = { tts?: TTSProvider; ivr?: IVRProvider };

const maxDeliveryAttempts = () => {
  const configured = Number(process.env.CLOSURE_VERIFICATION_MAX_ATTEMPTS ?? 3);
  return Number.isInteger(configured) && configured > 0 ? configured : 3;
};

export function buildClosurePrompt(input: { asset: string | null; title: string }, language: string | null | undefined) {
  const selectedLanguage = normalizeLanguage(language);
  const subject = (input.asset?.trim() || input.title.trim()).slice(0, 100);
  if (selectedLanguage === 'ta') {
    return `${subject} தொடர்பான பிரச்சினை சரிசெய்யப்பட்டதாகக் குறிக்கப்பட்டுள்ளது. சரியாகிவிட்டால் 1 ஐ அழுத்துங்கள். இன்னும் பிரச்சினை இருந்தால் 2 ஐ அழுத்துங்கள்.`;
  }
  if (selectedLanguage === 'hinglish') {
    return `${subject} ka issue theek kiya gaya hai. Agar ab theek hai to 1 dabayein. Agar issue abhi bhi hai to 2 dabayein.`;
  }
  return `${subject} की समस्या ठीक बताई गई है। अगर समस्या ठीक हो गई है तो 1 दबाएँ। अगर समस्या अभी भी है तो 2 दबाएँ।`;
}

export function buildClosureResultMessage(confirmed: boolean, language: string | null | undefined) {
  const selectedLanguage = normalizeLanguage(language);
  if (selectedLanguage === 'ta') return confirmed
    ? 'உங்கள் புகார் மூடப்பட்டது. உறுதிப்படுத்தியதற்கு நன்றி.'
    : 'உங்கள் புகார் மீண்டும் திறக்கப்பட்டது. குழு பிரச்சினையை மீண்டும் சரிபார்க்கும்.';
  if (selectedLanguage === 'hinglish') return confirmed
    ? 'Aapki report close kar di gayi hai. Confirm karne ke liye dhanyavaad.'
    : 'Aapki report phir se open kar di gayi hai. Team issue dobara check karegi.';
  return confirmed
    ? 'आपकी रिपोर्ट बंद कर दी गई है। पुष्टि करने के लिए धन्यवाद।'
    : 'आपकी रिपोर्ट फिर से खोल दी गई है। टीम समस्या दोबारा जाँचेगी।';
}

export async function completeTaskForVerification(db: DatabaseClient, taskId: string, actorId: string, providers: ClosureFeedbackProviders = {}) {
  const task = await db.task.findUnique({ where: { id: taskId }, include: { incident: { include: { voiceReports: { orderBy: { createdAt: 'asc' }, take: 1 } } } } });
  if (!task) throw new Error('Task not found');
  const completableStatuses: WorkflowStatus[] = ['OPEN', 'IN_PROGRESS', 'OVERDUE', 'ESCALATED', 'REOPENED', 'EMERGENCY'];
  if (!completableStatuses.includes(task.status)) throw new Error(`Cannot complete a task in ${task.status}.`);
  if (!canTransitionIncident(task.incident.status, 'REPORTER_VERIFICATION_PENDING')) throw new Error(`Cannot verify completion from incident state ${task.incident.status}.`);
  const reporter = await db.employee.findUnique({ where: { id: task.incident.reporterId } });
  if (!reporter) throw new Error('Original reporter no longer exists');
  const now = new Date();
  const language = normalizeLanguage(task.incident.voiceReports[0]?.language);
  const prompt = buildClosurePrompt({ asset: task.incident.asset, title: task.incident.title }, language);

  const completed = await db.$transaction(async (tx) => {
    const taskClaim = await tx.task.updateMany({
      where: { id: task.id, status: { in: completableStatuses } },
      data: { status: 'COMPLETED_BY_ASSIGNEE', completedAt: now }
    });
    if (!taskClaim.count) throw new Error('Cannot complete this task because its state has changed.');
    const incidentClaim = await tx.incident.updateMany({
      where: { id: task.incidentId, status: task.incident.status },
      data: { status: 'REPORTER_VERIFICATION_PENDING', reporterVerificationStatus: 'PENDING' }
    });
    if (!incidentClaim.count) throw new Error('Cannot request verification because the incident state has changed.');
    await tx.voiceReport.updateMany({ where: { incidentId: task.incidentId }, data: { status: 'REPORTER_VERIFICATION_PENDING' } });
    const attemptNumber = await tx.closureVerification.count({ where: { incidentId: task.incidentId } }) + 1;
    const verification = await tx.closureVerification.create({ data: {
      incidentId: task.incidentId,
      reporterId: reporter.id,
      attemptNumber,
      taskCompletedAt: now,
      language,
      prompt,
      deliveryMode: 'MOCK',
      deliveryStatus: 'PENDING'
    } });
    const updatedTask = await tx.task.findUnique({ where: { id: task.id } });
    await tx.auditLog.createMany({ data: [
      { actorId, incidentId: task.incidentId, action: 'TASK_COMPLETED_BY_ASSIGNEE', reason: 'Assignee marked the task complete; original reporter verification is required.', metadata: { taskId: task.id, verificationId: verification.id, completedAt: now.toISOString() } },
      { actorId: null, incidentId: task.incidentId, action: 'REPORTER_VERIFICATION_REQUESTED', reason: 'A spoken closure verification request was queued for the original reporter.', metadata: { taskId: task.id, verificationId: verification.id, reporterId: reporter.id, language, prompt } }
    ] });
    return { task: updatedTask, verification };
  });

  await dispatchClosureVerification(db, completed.verification.id, now, providers);
  const verification = await db.closureVerification.findUnique({ where: { id: completed.verification.id } });
  const incident = await db.incident.findUnique({ where: { id: task.incidentId }, select: { status: true } });
  return { task: completed.task, verification, incidentStatus: incident?.status ?? 'REPORTER_VERIFICATION_PENDING' };
}

export async function dispatchClosureVerification(
  db: DatabaseClient,
  verificationId: string,
  now = new Date(),
  providers: ClosureFeedbackProviders = {}
) {
  const verification = await db.closureVerification.findUnique({ where: { id: verificationId }, include: { incident: true } });
  if (!verification || verification.status !== 'PENDING') return { attempted: false, delivered: false };
  const claimed = await db.$transaction(async (tx) => {
    const claim = await tx.closureVerification.updateMany({
      where: { id: verification.id, status: 'PENDING', deliveryStatus: { in: ['PENDING', 'FAILED'] }, attemptCount: { lt: maxDeliveryAttempts() } },
      data: { deliveryStatus: 'PROCESSING', attemptCount: { increment: 1 }, lastAttemptAt: now }
    });
    if (!claim.count) return false;
    await tx.auditLog.create({ data: {
      actorId: null, incidentId: verification.incidentId, action: 'CLOSURE_NOTIFICATION_ATTEMPTED',
      reason: 'Attempting simulated spoken and IVR delivery to the original reporter.',
      metadata: { verificationId, reporterId: verification.reporterId, language: verification.language, attemptCount: verification.attemptCount + 1, deliveryMode: verification.deliveryMode }
    } });
    return true;
  });
  if (!claimed) return { attempted: false, delivered: false };

  const attemptCount = verification.attemptCount + 1;
  try {
    const tts = providers.tts ?? textToSpeechProvider();
    const ivr = providers.ivr ?? ivrProvider();
    await tts.speak({ text: verification.prompt, language: normalizeLanguage(verification.language), recipientId: verification.reporterId, kind: 'CLOSURE_VERIFICATION_PROMPT' });
    const call = await ivr.call({ verificationId, recipientId: verification.reporterId, language: normalizeLanguage(verification.language), prompt: verification.prompt, kind: 'CLOSURE_VERIFICATION' });
    await db.$transaction(async (tx) => {
      await tx.closureVerification.updateMany({ where: { id: verification.id, deliveryStatus: 'PROCESSING' }, data: { deliveryStatus: 'SENT' } });
      await tx.auditLog.create({ data: {
        actorId: null, incidentId: verification.incidentId, action: 'CLOSURE_NOTIFICATION_SENT',
        reason: 'Mock TTS and IVR providers recorded the spoken verification request; no real call was placed.',
        metadata: { verificationId, reporterId: verification.reporterId, language: verification.language, prompt: verification.prompt, deliveryMode: 'MOCK', providerStatus: call.status, attemptCount }
      } });
    });

    if (call.response === '1' || call.response === '2') {
      const response = await recordReporterVerification(db, verification.id, verification.reporterId, call.response, undefined, now, providers);
      return { attempted: true, delivered: true, response: response.status };
    }
    await db.auditLog.create({ data: {
      actorId: null, incidentId: verification.incidentId,
      action: call.response === undefined ? 'REPORTER_VERIFICATION_NO_RESPONSE' : 'REPORTER_VERIFICATION_INVALID_RESPONSE',
      reason: call.response === undefined ? 'No IVR input was received; verification remains pending.' : 'Invalid IVR input was ignored; verification remains pending.',
      metadata: { verificationId, reporterId: verification.reporterId, response: call.response?.slice(0, 50) ?? null }
    } });
    return { attempted: true, delivered: true, response: 'REPORTER_VERIFICATION_PENDING' };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : 'Spoken verification delivery failed';
    await db.$transaction(async (tx) => {
      await tx.closureVerification.updateMany({ where: { id: verification.id, deliveryStatus: 'PROCESSING' }, data: { deliveryStatus: 'FAILED' } });
      await tx.auditLog.create({ data: {
        actorId: null, incidentId: verification.incidentId, action: 'CLOSURE_NOTIFICATION_FAILED',
        reason: 'Spoken or IVR delivery failed and remains eligible for bounded worker retry.',
        metadata: { verificationId, reporterId: verification.reporterId, language: verification.language, attemptCount, error: message }
      } });
    });
    return { attempted: true, delivered: false, error: message };
  }
}

function finalStatusForVerification(status: string) {
  if (status === 'CONFIRMED') return 'CLOSED';
  if (status === 'REJECTED') return 'REOPENED';
  return 'REPORTER_VERIFICATION_PENDING';
}

export async function recordReporterVerification(
  db: DatabaseClient,
  verificationId: string,
  reporterId: string,
  response: unknown,
  evidenceRef?: string,
  now = new Date(),
  providers: ClosureFeedbackProviders = {},
  expectedIncidentId?: string
) {
  const verification = await db.closureVerification.findUnique({ where: { id: verificationId }, include: { incident: { include: { tasks: { include: { assignee: true } } } } } });
  if (!verification) throw new Error('Closure verification not found');
  if (expectedIncidentId && verification.incidentId !== expectedIncidentId) throw new Error('Closure verification does not belong to this incident');
  if (verification.reporterId !== reporterId || verification.incident.reporterId !== reporterId) throw new Error('Only the original reporter can verify closure');
  if (verification.status !== 'PENDING') return { status: finalStatusForVerification(verification.status), verificationId, alreadyProcessed: true };

  if (response !== '1' && response !== '2') {
    await db.auditLog.create({ data: {
      actorId: reporterId,
      incidentId: verification.incidentId,
      action: response === undefined ? 'REPORTER_VERIFICATION_NO_RESPONSE' : 'REPORTER_VERIFICATION_INVALID_RESPONSE',
      reason: response === undefined ? 'No IVR input was received; verification remains pending.' : 'Invalid IVR input was ignored; verification remains pending.',
      metadata: { verificationId, response: typeof response === 'string' ? response.slice(0, 50) : null, responseType: typeof response }
    } });
    return { status: 'REPORTER_VERIFICATION_PENDING', verificationId, alreadyProcessed: false };
  }
  if (verification.incident.status !== 'REPORTER_VERIFICATION_PENDING') throw new Error('This incident is not awaiting reporter verification');

  const confirmed = response === '1';
  const intermediateStatus = confirmed ? 'REPORTER_CONFIRMED' : 'REPORTER_REJECTED';
  const finalStatus = confirmed ? 'CLOSED' : 'REOPENED';
  if (!canTransitionIncident(verification.incident.status, intermediateStatus) || !canTransitionIncident(intermediateStatus, finalStatus)) throw new Error('Invalid reporter verification transition');
  const outcome = await db.$transaction(async (tx) => {
    const claim = await tx.closureVerification.updateMany({
      where: { id: verification.id, reporterId, status: 'PENDING' },
      data: { status: confirmed ? 'CONFIRMED' : 'REJECTED', response, evidenceRef, respondedAt: now }
    });
    if (!claim.count) {
      const current = await tx.closureVerification.findUnique({ where: { id: verification.id } });
      return { status: finalStatusForVerification(current?.status ?? 'PENDING'), alreadyProcessed: true };
    }
    const stateClaim = await tx.incident.updateMany({
      where: { id: verification.incidentId, status: 'REPORTER_VERIFICATION_PENDING' },
      data: { status: intermediateStatus, reporterVerificationStatus: confirmed ? 'CONFIRMED' : 'REJECTED' }
    });
    if (!stateClaim.count) throw new Error('This incident is not awaiting reporter verification');
    const finalClaim = await tx.incident.updateMany({
      where: { id: verification.incidentId, status: intermediateStatus },
      data: confirmed
        ? { status: 'CLOSED', reporterVerifiedAt: now }
        : { status: 'REOPENED', reopenedAt: now, reopenReason: 'Original reporter said the issue is still present.' }
    });
    if (!finalClaim.count) throw new Error('The incident state changed before closure verification completed');
    await tx.voiceReport.updateMany({ where: { incidentId: verification.incidentId }, data: { status: finalStatus } });
    if (!confirmed) {
      // Keep completedAt: ClosureVerification.taskCompletedAt and audit history preserve this completion cycle.
      await tx.task.updateMany({ where: { incidentId: verification.incidentId, status: 'COMPLETED_BY_ASSIGNEE' }, data: { status: 'OPEN' } });
    }
    await tx.auditLog.createMany({ data: [
      { actorId: reporterId, incidentId: verification.incidentId, action: confirmed ? 'REPORTER_CONFIRMED' : 'REPORTER_REJECTED', reason: confirmed ? 'Original reporter confirmed the issue is fixed.' : 'Original reporter said the issue is still present.', metadata: { verificationId, response, evidenceRef: evidenceRef ?? null, respondedAt: now.toISOString() } },
      { actorId: reporterId, incidentId: verification.incidentId, action: confirmed ? 'INCIDENT_CLOSED' : 'INCIDENT_REOPENED', reason: confirmed ? 'Incident closed after original reporter confirmation.' : 'Incident and task reopened after original reporter rejection.', metadata: { verificationId, response } },
      ...(!confirmed ? [{ actorId: reporterId, incidentId: verification.incidentId, action: 'TASK_REOPENED', reason: 'Task returned to the responsible workflow; prior completion timestamp was retained.', metadata: { verificationId, taskIds: verification.incident.tasks.map((task) => task.id) } }] : [])
    ] });
    return { status: finalStatus, alreadyProcessed: false };
  });

  if (outcome.alreadyProcessed) return { ...outcome, verificationId };
  const finalText = buildClosureResultMessage(confirmed, verification.language);
  await db.auditLog.create({ data: { actorId: null, incidentId: verification.incidentId, action: 'FINAL_STATUS_SPOKEN_ATTEMPTED', reason: 'Attempting to speak the verification outcome to the original reporter.', metadata: { verificationId, reporterId, language: verification.language, message: finalText } } });
  try {
    await (providers.tts ?? textToSpeechProvider()).speak({ text: finalText, language: normalizeLanguage(verification.language), recipientId: reporterId, kind: 'FINAL_STATUS' });
    await db.auditLog.create({ data: { actorId: null, incidentId: verification.incidentId, action: 'FINAL_STATUS_SPOKEN_SIMULATED', reason: 'Mock TTS recorded the reporter-facing final status.', metadata: { verificationId, reporterId, language: verification.language, message: finalText, deliveryMode: 'MOCK' } } });
  } catch (error) {
    await db.auditLog.create({ data: { actorId: null, incidentId: verification.incidentId, action: 'FINAL_STATUS_SPOKEN_FAILED', reason: 'The workflow transition succeeded, but spoken final feedback failed.', metadata: { verificationId, reporterId, language: verification.language, error: error instanceof Error ? error.message.slice(0, 500) : 'unknown error' } } });
  }
  if (!confirmed) {
    const task = verification.incident.tasks[0];
    if (task) {
      try {
        const notice = await sendNotification(db, { kind: 'REOPENED', to: task.assignee.email, recipientId: task.assignee.id, subject: `Reopened: ${verification.incident.incidentNumber}`, body: 'The original reporter said the issue is still present. Please investigate again.', incidentId: verification.incidentId, taskId: task.id });
        await db.auditLog.create({ data: { actorId: null, incidentId: verification.incidentId, action: notice.status === 'FAILED' ? 'REOPENED_ASSIGNEE_NOTIFICATION_FAILED' : 'REOPENED_ASSIGNEE_NOTIFIED', reason: notice.status === 'FAILED' ? 'The incident reopened but the assignee notification failed.' : 'The responsible assignee was notified that the task reopened.', metadata: { verificationId, taskId: task.id, notificationId: notice.id, deliveryMode: process.env.MOCK_EMAIL === 'false' ? 'CONFIGURED_EMAIL' : 'MOCK' } } });
      } catch (error) {
        await db.auditLog.create({ data: { actorId: null, incidentId: verification.incidentId, action: 'REOPENED_ASSIGNEE_NOTIFICATION_FAILED', reason: 'The incident reopened but notification dispatch raised an error.', metadata: { verificationId, taskId: task.id, error: error instanceof Error ? error.message.slice(0, 500) : 'unknown error' } } });
      }
    }
  }
  return { status: outcome.status, verificationId, alreadyProcessed: false };
}
