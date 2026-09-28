import { randomUUID } from 'node:crypto';
import { mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import type { Request, Response, NextFunction } from 'express';
import type { DatabaseClient } from '../db.js';
import { requireAuth, requireRoles } from '../auth.js';
import { extractionSchema } from '../services/extraction.js';
import { audioPreprocessor, speechProvider } from '../services/speech.js';
import { ClarificationRequired, createIncidentWorkflow } from '../services/workflow.js';
import { sendNotification } from '../services/email.js';
import { sendTaskEscalation } from '../services/worker.js';
import { completeTaskForVerification, recordReporterVerification } from '../services/closure.js';
import { configuredExtractionProvider } from '../services/extraction.js';
import { speakStatus } from '../services/voice-feedback.js';
import { canTransitionIncident } from '../services/safety.js';
import { canonicalAudioMimeType, validateAudioFile } from '../services/audio-validation.js';

const uploadDirectory = path.resolve(fileURLToPath(new URL('../../../../uploads/', import.meta.url)));
const extensions: Record<string, string> = {
  'audio/webm': '.webm', 'audio/ogg': '.ogg', 'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a',
  'audio/wav': '.wav', 'audio/mpeg': '.mp3', 'audio/aac': '.aac'
};
const upload = multer({
  storage: multer.diskStorage({
    destination: (_request, _file, callback) => {
      void mkdir(uploadDirectory, { recursive: true })
        .then(() => callback(null, uploadDirectory))
        .catch((error: Error) => callback(error, uploadDirectory));
    },
    filename: (_request, file, callback) => callback(null, `${randomUUID()}${extensions[canonicalAudioMimeType(file.mimetype)] ?? '.audio'}`)
  }),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
  fileFilter: (_request, file, callback) => callback(null, Boolean(extensions[canonicalAudioMimeType(file.mimetype)]))
});

function requireDb(db: DatabaseClient | null, response: Response): db is DatabaseClient {
  if (db) return true;
  response.status(503).json({ error: 'The database is not configured.' });
  return false;
}

function routeParam(request: Request, key: string) {
  const value = request.params[key];
  return Array.isArray(value) ? value[0]! : String(value ?? '');
}

function managerCanAccessIncident(userId: string, incident: {
  reporterId: string;
  tasks: Array<{ assigneeId: string; assignee?: { managerId: string | null } | null }>;
}) {
  return incident.reporterId === userId || incident.tasks.some((task) =>
    task.assigneeId === userId || task.assignee?.managerId === userId
  );
}

function handleError(error: unknown, response: Response) {
  if (error instanceof ClarificationRequired) return response.status(202).json({ requiresConfirmation: true, clarification: error.message, options: error.options });
  if (error instanceof z.ZodError) return response.status(400).json({ error: 'Request validation failed.', details: error.flatten() });
  const message = error instanceof Error ? error.message : 'Unexpected server error';
  if (message.includes('ENOENT')) return response.status(404).json({ error: 'The requested report was not found.' });
  console.error(JSON.stringify({ event: 'request_failed', message }));
  return response.status(500).json({ error: 'The request could not be completed.' });
}

function asyncRoute(handler: (request: Request, response: Response, next: NextFunction) => Promise<unknown>) {
  return (request: Request, response: Response, next: NextFunction) => { void handler(request, response, next).catch(next); };
}

const confirmationSchema = z.object({
  extraction: extractionSchema.partial().optional(),
  assignedEmployeeId: z.string().min(1).optional()
});
const manualIncidentSchema = z.object({
  title: z.string().trim().min(3).max(160),
  description: z.string().trim().min(3).max(4000),
  location: z.string().trim().max(300).nullable().optional(),
  asset: z.string().trim().max(200).nullable().optional(),
  responsibleDepartment: z.string().trim().max(100).nullable(),
  requestedAction: z.string().trim().min(3).max(500),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  deadline: z.string().datetime(),
  assigneeId: z.string().min(1).optional()
});
const taskStatusSchema = z.object({ status: z.enum(['IN_PROGRESS', 'COMPLETED']) });
const languageSchema = z.enum(['hi', 'hinglish', 'ta']).default('hi');

export function apiRouter(db: DatabaseClient | null) {
  const router = Router();
  router.use(requireAuth);

  router.post('/voice/upload', upload.single('audio'), asyncRoute(async (request, response) => {
    if (!requireDb(db, response)) return;
    const transcriptFromClient = typeof request.body.transcript === 'string' ? request.body.transcript.trim() : '';
    const language = languageSchema.parse(request.body.language);
    if (!request.file && !transcriptFromClient) return response.status(400).json({ error: 'Record audio or enter a transcript before submitting.' });
    const suppliedDuration = request.body.durationSeconds;
    const durationSeconds = suppliedDuration === undefined || suppliedDuration === '' ? null : Number(suppliedDuration);
    if (durationSeconds !== null && (!Number.isFinite(durationSeconds) || durationSeconds < 0 || durationSeconds > 30)) {
      if (request.file) await unlink(request.file.path).catch(() => undefined);
      return response.status(400).json({ error: 'Voice reports must be 30 seconds or shorter.' });
    }
    if (request.file && !(await validateAudioFile(request.file.path, request.file.mimetype))) {
      await unlink(request.file.path).catch(() => undefined);
      return response.status(415).json({ error: 'The uploaded file does not match a supported audio format.' });
    }
    const report = await db.voiceReport.create({ data: {
      reporterId: request.user!.sub,
      audioPath: request.file ? path.relative(path.resolve(uploadDirectory, '..'), request.file.path) : null,
      audioMimeType: request.file ? canonicalAudioMimeType(request.file.mimetype) : null,
      durationSeconds,
      language,
      status: 'VOICE_RECEIVED'
    } });
    try {
      await db.voiceReport.update({ where: { id: report.id }, data: { status: 'TRANSCRIBING' } });
      const preparedAudio = request.file ? await audioPreprocessor().prepare(request.file.path) : null;
      const rawTranscription = request.file
        ? await speechProvider().transcribe(preparedAudio!.audioPath, canonicalAudioMimeType(request.file.mimetype), language, transcriptFromClient || undefined)
        : { transcript: transcriptFromClient, language, confidence: null, audioQuality: 'UNKNOWN' as const };
      const transcription = rawTranscription.audioQuality === 'UNKNOWN' && preparedAudio
        ? { ...rawTranscription, audioQuality: preparedAudio.quality }
        : rawTranscription;
      await db.voiceReport.update({ where: { id: report.id }, data: {
        transcript: transcription.transcript, language: transcription.language, transcriptionConfidence: transcription.confidence,
        audioQuality: transcription.audioQuality
      } });
      if (transcription.confidence !== null && transcription.confidence < Number(process.env.STT_MIN_CONFIDENCE ?? 0.55)) {
        await db.voiceReport.update({ where: { id: report.id }, data: { status: 'NEEDS_CLARIFICATION', retryCount: { increment: 1 } } });
        await db.auditLog.create({ data: { actorId: request.user!.sub, action: 'VOICE_RETRY_REQUESTED', reason: 'Speech confidence was below the configured threshold.', metadata: { voiceReportId: report.id, confidence: transcription.confidence, audioQuality: transcription.audioQuality } } });
        await speakStatus({ text: 'The recording was unclear. Please move closer to the microphone and say it again.', language: transcription.language, recipientId: request.user!.sub, kind: 'VOICE_RETRY_REQUEST' });
        return response.status(202).json({ voiceReportId: report.id, transcript: transcription.transcript, confidence: transcription.confidence, audioQuality: transcription.audioQuality, retryRequired: true, message: 'The recording was unclear. Please move closer to the microphone or record again.' });
      }
      await db.voiceReport.update({ where: { id: report.id }, data: { status: 'EXTRACTION_PENDING' } });
      const extraction = await configuredExtractionProvider.extract(transcription.transcript, transcription.language);
      await db.voiceReport.update({ where: { id: report.id }, data: {
        language: transcription.language,
        transcriptionConfidence: transcription.confidence,
        extraction,
        status: extraction.requiresConfirmation ? 'AWAITING_CONFIRMATION' : 'SAFETY_CHECK'
      } });
      await db.auditLog.createMany({ data: [
        { actorId: request.user!.sub, action: 'VOICE_REPORT_CREATED', reason: 'Audio and transcript received.', metadata: { voiceReportId: report.id } },
        { actorId: null, action: 'TRANSCRIPTION_COMPLETED', reason: 'Speech-to-text provider returned a transcript.', metadata: { voiceReportId: report.id, confidence: transcription.confidence } }
      ] });
      try {
        const workflow = await createIncidentWorkflow(db, { reporterId: request.user!.sub, voiceReportId: report.id, extraction });
        return response.status(201).json({ voiceReportId: report.id, transcript: transcription.transcript, extraction, incident: workflow.incident, task: workflow.task, assignedTo: workflow.assignee, duplicate: 'duplicate' in workflow ? workflow.duplicate : false, duplicateReviewPending: 'duplicateReviewPending' in workflow ? workflow.duplicateReviewPending : false });
      } catch (error) {
        if (!(error instanceof ClarificationRequired)) throw error;
        await speakStatus({ text: error.message, language: transcription.language, recipientId: request.user!.sub, kind: 'REPORT_CLARIFICATION' });
        return response.status(202).json({ voiceReportId: report.id, transcript: transcription.transcript, extraction, requiresConfirmation: true, clarification: error.message, options: error.options });
      }
    } catch (error) {
      await db.voiceReport.update({ where: { id: report.id }, data: { status: 'FAILED' } });
      return handleError(error, response);
    }
  }));

  router.post('/voice/transcribe', upload.single('audio'), asyncRoute(async (request, response) => {
    if (!request.file) return response.status(400).json({ error: 'Attach a supported audio recording.' });
    try {
      if (!(await validateAudioFile(request.file.path, request.file.mimetype))) return response.status(415).json({ error: 'The uploaded file does not match a supported audio format.' });
      const language = languageSchema.parse(request.body.language);
      const prepared = await audioPreprocessor().prepare(request.file.path);
      const transcription = await speechProvider().transcribe(prepared.audioPath, canonicalAudioMimeType(request.file.mimetype), language);
      const result = transcription.audioQuality === 'UNKNOWN' ? { ...transcription, audioQuality: prepared.quality } : transcription;
      if (db) await db.auditLog.create({ data: { actorId: request.user!.sub, action: 'TRANSCRIPTION_COMPLETED', reason: `Speech-to-text provider returned ${result.language}.`, metadata: { confidence: result.confidence } } });
      return response.json(result);
    } finally {
      await unlink(request.file.path).catch(() => undefined);
    }
  }));

  router.get('/voice/:id/audio', asyncRoute(async (request, response) => {
    if (!requireDb(db, response)) return;
    const report = await db.voiceReport.findUnique({ where: { id: routeParam(request, 'id') }, include: { incident: { include: { tasks: { include: { assignee: true } } } } } });
    if (!report?.audioPath) return response.status(404).json({ error: 'Audio recording not found.' });
    const visible = request.user!.role === 'ADMIN' || report.reporterId === request.user!.sub || report.incident?.tasks.some((task) => task.assigneeId === request.user!.sub || (request.user!.role === 'MANAGER' && task.assignee.managerId === request.user!.sub));
    if (!visible) return response.status(403).json({ error: 'You cannot access this audio recording.' });
    return response.type(report.audioMimeType ?? 'application/octet-stream').sendFile(path.resolve(uploadDirectory, path.basename(report.audioPath)));
  }));

  router.get('/reports', asyncRoute(async (request, response) => {
    if (!requireDb(db, response)) return;
    const reports = await db.voiceReport.findMany({ where: request.user!.role === 'ADMIN' ? {} : { reporterId: request.user!.sub }, include: { incident: { select: { id: true, incidentNumber: true, title: true, status: true } } }, orderBy: { createdAt: 'desc' }, take: 100 });
    return response.json({ reports });
  }));

  router.post('/voice/:id/confirm', asyncRoute(async (request, response) => {
    if (!requireDb(db, response)) return;
    const parsed = confirmationSchema.parse(request.body);
    const report = await db.voiceReport.findFirst({ where: { id: routeParam(request, 'id'), reporterId: request.user!.sub } });
    if (!report?.transcript || !report.extraction) return response.status(404).json({ error: 'Voice report not found or no longer needs confirmation.' });
    const previous = report.extraction as import('../services/extraction.js').IncidentExtraction;
    const extraction = extractionSchema.parse({ ...previous, ...parsed.extraction, requiresConfirmation: false, confidence: parsed.extraction?.confidence ?? report.transcriptionConfidence ?? previous.confidence ?? 0.7 });
    const workflow = await createIncidentWorkflow(db, {
      reporterId: request.user!.sub, voiceReportId: report.id, extraction,
      assignedEmployeeId: parsed.assignedEmployeeId, actorId: request.user!.sub, confirmed: true
    });
    return response.status(201).json({ incident: workflow.incident, task: workflow.task, assignedTo: workflow.assignee });
  }));

  router.post('/incidents/:id/verify-closure', asyncRoute(async (request, response) => {
    if (!requireDb(db, response)) return;
    const input = z.object({ response: z.enum(['1', '2']), evidenceRef: z.string().max(500).optional() }).parse(request.body);
    try {
      const result = await recordReporterVerification(db, routeParam(request, 'id'), request.user!.sub, input.response, input.evidenceRef);
      return response.json(result);
    } catch (error) {
      if (error instanceof Error && /original reporter/.test(error.message)) return response.status(403).json({ error: error.message });
      if (error instanceof Error && /not found/.test(error.message)) return response.status(404).json({ error: error.message });
      if (error instanceof Error && /not awaiting|pending closure/.test(error.message)) return response.status(409).json({ error: error.message });
      throw error;
    }
  }));

  router.post('/incidents/:id/emergency-response', requireRoles('MANAGER', 'ADMIN'), asyncRoute(async (request, response) => {
    if (!requireDb(db, response)) return;
    const incidentId = routeParam(request, 'id');
    const incident = await db.incident.findUnique({ where: { id: incidentId }, include: { voiceReports: { orderBy: { createdAt: 'asc' }, take: 1 }, tasks: { include: { assignee: { select: { managerId: true } } } } } });
    if (!incident) return response.status(404).json({ error: 'Incident not found.' });
    if (request.user!.role === 'MANAGER' && !managerCanAccessIncident(request.user!.sub, incident)) return response.status(403).json({ error: 'You cannot access this incident.' });
    if (!incident.isEmergency) return response.status(409).json({ error: 'This is not an emergency incident.' });
    const event = await db.emergencyEvent.findFirst({ where: { incidentId, kind: 'IMMEDIATE_ALERT' }, orderBy: { triggeredAt: 'desc' } });
    if (!event || event.respondedAt) return response.status(409).json({ error: 'No unanswered emergency alert was found.' });
    const now = new Date();
    await db.$transaction(async (tx) => {
      await tx.emergencyEvent.update({ where: { id: event.id }, data: { status: 'RESPONDED', respondedAt: now } });
      await tx.incident.update({ where: { id: incidentId }, data: { status: 'IN_PROGRESS', emergencyStatus: 'RESPONDED' } });
      await tx.task.updateMany({ where: { incidentId, status: 'OPEN' }, data: { status: 'IN_PROGRESS' } });
      await tx.voiceReport.updateMany({ where: { incidentId }, data: { status: 'IN_PROGRESS' } });
      await tx.auditLog.create({ data: { actorId: request.user!.sub, incidentId, action: 'EMERGENCY_RESPONSE_RECORDED', reason: 'Authorized manager recorded emergency response.', metadata: { emergencyEventId: event.id, responseDeadline: event.responseDeadline, respondedAt: now } } });
    });
    await speakStatus({ text: 'A response team has acknowledged your emergency report.', language: incident.voiceReports[0]?.language ?? null, recipientId: incident.reporterId, kind: 'EMERGENCY_PROGRESS' });
    return response.json({ incidentId, status: 'RESPONDED', responseDeadline: event.responseDeadline, respondedAt: now });
  }));

  router.get('/incidents', asyncRoute(async (request, response) => {
    if (!requireDb(db, response)) return;
    const user = request.user!;
    const where = user.role === 'ADMIN' ? {} : user.role === 'MANAGER'
      ? { OR: [{ reporterId: user.sub }, { tasks: { some: { assignee: { managerId: user.sub } } } }, { tasks: { some: { assigneeId: user.sub } } }] }
      : { reporterId: user.sub };
    const incidents = await db.incident.findMany({ where, orderBy: { createdAt: 'desc' }, include: {
      reporter: { select: { id: true, name: true, email: true } },
      tasks: { include: { assignee: { select: { id: true, name: true, email: true } } } }
    } });
    return response.json({ incidents });
  }));

  router.post('/incidents', asyncRoute(async (request, response) => {
    if (!requireDb(db, response)) return;
    const input = manualIncidentSchema.parse(request.body);
    const extraction = extractionSchema.parse({
      title: input.title, description: input.description, abnormality: input.description,
      asset: input.asset ?? null, location: input.location ?? null,
      responsibleDepartment: input.responsibleDepartment, responsiblePerson: null,
      priority: input.priority, deadline: input.deadline, requestedAction: input.requestedAction,
      confidence: 1, missingInformation: [], requiresConfirmation: false
    });
    const report = await db.voiceReport.create({ data: { reporterId: request.user!.sub, transcript: input.description, language: 'en', transcriptionConfidence: 1, extraction, status: 'TRANSCRIBED' } });
    try {
      const created = await createIncidentWorkflow(db, { reporterId: request.user!.sub, voiceReportId: report.id, extraction, assignedEmployeeId: input.assigneeId, actorId: request.user!.sub, confirmed: true });
      return response.status(201).json({ incident: created.incident, task: created.task });
    } catch (error) {
      if (error instanceof ClarificationRequired) return response.status(202).json({ voiceReportId: report.id, requiresConfirmation: true, clarification: error.message, options: error.options });
      throw error;
    }
  }));

  router.patch('/incidents/:id', requireRoles('MANAGER', 'ADMIN'), asyncRoute(async (request, response) => {
    if (!requireDb(db, response)) return;
    const input = z.object({ title: z.string().trim().min(3).max(160).optional(), description: z.string().trim().min(3).max(4000).optional(), location: z.string().trim().max(300).nullable().optional(), priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(), deadline: z.string().datetime().optional() }).refine((value) => Object.keys(value).length > 0).parse(request.body);
    const incidentId = routeParam(request, 'id');
    const incident = await db.incident.findUnique({ where: { id: incidentId }, include: { tasks: { include: { assignee: { select: { managerId: true } } } } } });
    if (!incident) return response.status(404).json({ error: 'Incident not found.' });
    if (request.user!.role === 'MANAGER' && !managerCanAccessIncident(request.user!.sub, incident)) return response.status(403).json({ error: 'You cannot access this incident.' });
    const updated = await db.$transaction(async (tx) => {
      const result = await tx.incident.update({ where: { id: incidentId }, data: { ...input, deadline: input.deadline ? new Date(input.deadline) : undefined } });
      if (input.deadline) await tx.task.updateMany({ where: { incidentId }, data: { deadline: new Date(input.deadline) } });
      await tx.auditLog.create({ data: { actorId: request.user!.sub, incidentId, action: 'INCIDENT_UPDATED', reason: 'Incident details were edited by a manager.', metadata: { fields: Object.keys(input) } } });
      return result;
    });
    return response.json({ incident: updated });
  }));

  router.get('/incidents/:id', asyncRoute(async (request, response) => {
    if (!requireDb(db, response)) return;
    const incident = await db.incident.findUnique({ where: { id: routeParam(request, 'id') }, include: {
      reporter: { select: { id: true, name: true, email: true } },
      voiceReports: true,
      tasks: { include: { assignee: { select: { id: true, name: true, email: true, managerId: true } }, assignments: { include: { employee: { select: { id: true, name: true, email: true } } }, orderBy: { createdAt: 'desc' } }, reminders: { orderBy: { scheduledAt: 'desc' } }, escalations: { include: { manager: { select: { id: true, name: true, email: true } } }, orderBy: { createdAt: 'desc' } }, notifications: { orderBy: { createdAt: 'desc' } } } },
      notifications: { orderBy: { createdAt: 'desc' } }, auditEvents: { orderBy: { createdAt: 'asc' }, include: { actor: { select: { id: true, name: true } } } }
    } });
    if (!incident) return response.status(404).json({ error: 'Incident not found.' });
    const canView = request.user!.role === 'ADMIN' || incident.reporterId === request.user!.sub || incident.tasks.some((task) => task.assigneeId === request.user!.sub) || (request.user!.role === 'MANAGER' && incident.tasks.some((task) => task.assignee.managerId === request.user!.sub));
    if (!canView) return response.status(403).json({ error: 'You cannot view this incident.' });
    return response.json({ incident });
  }));

  router.get('/tasks', asyncRoute(async (request, response) => {
    if (!requireDb(db, response)) return;
    const user = request.user!;
    const where = user.role === 'ADMIN' ? {} : user.role === 'MANAGER'
      ? { OR: [{ assigneeId: user.sub }, { assignee: { managerId: user.sub } }] }
      : { assigneeId: user.sub };
    const tasks = await db.task.findMany({ where, orderBy: [{ deadline: 'asc' }], include: {
      incident: { select: { id: true, incidentNumber: true, title: true, location: true, priority: true, status: true } },
      assignee: { select: { id: true, name: true, email: true } }
    } });
    return response.json({ tasks });
  }));

  router.get('/duplicate-reviews', requireRoles('MANAGER', 'ADMIN'), asyncRoute(async (request, response) => {
    if (!requireDb(db, response)) return;
    const where = request.user!.role === 'ADMIN' ? { status: 'PENDING' as const } : { status: 'PENDING' as const, candidate: { tasks: { some: { assignee: { managerId: request.user!.sub } } } } };
    const reviews = await db.duplicateReview.findMany({ where, include: { candidate: { include: { voiceReports: true, tasks: { include: { assignee: true } } } }, existingIncident: { include: { voiceReports: true, tasks: { include: { assignee: true } } } } }, orderBy: { createdAt: 'desc' } });
    return response.json({ reviews });
  }));

  router.patch('/duplicate-reviews/:id', requireRoles('MANAGER', 'ADMIN'), asyncRoute(async (request, response) => {
    if (!requireDb(db, response)) return;
    const input = z.object({ decision: z.enum(['MERGED', 'DISTINCT']) }).parse(request.body);
    const review = await db.duplicateReview.findUnique({ where: { id: routeParam(request, 'id') }, include: { candidate: { include: { tasks: { include: { assignee: true } } } }, existingIncident: true } });
    if (!review || review.status !== 'PENDING') return response.status(404).json({ error: 'Pending duplicate review not found.' });
    if (request.user!.role === 'MANAGER' && !review.candidate.tasks.some((task) => task.assignee.managerId === request.user!.sub)) return response.status(403).json({ error: 'You cannot review this duplicate match.' });
    if (input.decision === 'MERGED') {
      await db.$transaction(async (tx) => {
        await tx.voiceReport.updateMany({ where: { incidentId: review.candidateId }, data: { incidentId: review.existingIncidentId } });
        await tx.incident.update({ where: { id: review.existingIncidentId }, data: { duplicateGroupId: review.existingIncidentId } });
        await tx.incident.update({ where: { id: review.candidateId }, data: { status: 'DUPLICATE_MERGED', duplicateGroupId: review.existingIncidentId, duplicateOfIncidentId: review.existingIncidentId, requiresConfirmation: false } });
        await tx.task.updateMany({ where: { incidentId: review.candidateId }, data: { status: 'DUPLICATE_MERGED' } });
        await tx.duplicateReview.update({ where: { id: review.id }, data: { status: 'MERGED', reviewedById: request.user!.sub, reviewedAt: new Date() } });
        await tx.auditLog.createMany({ data: [
          { actorId: request.user!.sub, incidentId: review.existingIncidentId, action: 'DUPLICATE_REPORTS_MERGED', reason: 'Manager confirmed the reports describe the same incident.', metadata: { candidateId: review.candidateId, reviewId: review.id, confidence: review.confidence } },
          { actorId: request.user!.sub, incidentId: review.candidateId, action: 'INCIDENT_MARKED_DUPLICATE', reason: `Merged into ${review.existingIncident.incidentNumber}.`, metadata: { existingIncidentId: review.existingIncidentId, reviewId: review.id } }
        ] });
      });
      return response.json({ decision: 'MERGED', incidentId: review.existingIncidentId });
    }
    await db.$transaction(async (tx) => {
      await tx.duplicateReview.update({ where: { id: review.id }, data: { status: 'DISTINCT', reviewedById: request.user!.sub, reviewedAt: new Date() } });
      await tx.incident.update({ where: { id: review.candidateId }, data: { status: 'OPEN', requiresConfirmation: false } });
      await tx.auditLog.create({ data: { actorId: request.user!.sub, incidentId: review.candidateId, action: 'DUPLICATE_REVIEW_DISTINCT', reason: 'Manager confirmed this is a separate incident.', metadata: { reviewId: review.id, existingIncidentId: review.existingIncidentId } } });
    });
    const task = review.candidate.tasks[0];
    if (task) await sendNotification(db, { kind: 'ASSIGNMENT', to: task.assignee.email, recipientId: task.assigneeId, subject: `Action required: ${review.candidate.incidentNumber}`, body: `${task.title}\n\n${task.description}`, incidentId: review.candidateId, taskId: task.id });
    return response.json({ decision: 'DISTINCT', incidentId: review.candidateId });
  }));

  router.post('/tasks', requireRoles('MANAGER', 'ADMIN'), asyncRoute(async (request, response) => {
    if (!requireDb(db, response)) return;
    const input = z.object({ incidentId: z.string().min(1), title: z.string().trim().min(3).max(160), description: z.string().trim().min(3).max(4000), assigneeId: z.string().min(1), deadline: z.string().datetime() }).parse(request.body);
    const [incident, assignee] = await Promise.all([
      db.incident.findUnique({ where: { id: input.incidentId }, include: { tasks: { include: { assignee: { select: { managerId: true } } } } } }),
      db.employee.findFirst({ where: { id: input.assigneeId, isActive: true } })
    ]);
    if (!incident) return response.status(404).json({ error: 'Incident not found.' });
    if (request.user!.role === 'MANAGER' && !managerCanAccessIncident(request.user!.sub, incident)) return response.status(403).json({ error: 'You cannot access this incident.' });
    if (!assignee) return response.status(400).json({ error: 'Choose an active employee.' });
    const task = await db.$transaction(async (tx) => {
      const created = await tx.task.create({ data: { incidentId: incident.id, title: input.title, description: input.description, assigneeId: assignee.id, createdById: request.user!.sub, deadline: new Date(input.deadline) } });
      await tx.assignment.create({ data: { taskId: created.id, employeeId: assignee.id, assignedById: request.user!.sub, reason: 'Task assigned by a manager.' } });
      await tx.auditLog.create({ data: { actorId: request.user!.sub, incidentId: incident.id, action: 'TASK_CREATED', reason: `Manager assigned a task to ${assignee.name}.`, metadata: { taskId: created.id } } });
      return created;
    });
    await sendNotification(db, { kind: 'ASSIGNMENT', to: assignee.email, recipientId: assignee.id, subject: `Action required: ${incident.incidentNumber}`, body: `${input.title}\n\n${input.description}\n\nDeadline: ${new Date(input.deadline).toLocaleString()}`, incidentId: incident.id, taskId: task.id });
    return response.status(201).json({ task });
  }));

  router.patch('/tasks/:id', asyncRoute(async (request, response) => {
    if (!requireDb(db, response)) return;
    const parsed = taskStatusSchema.parse(request.body);
    const task = await db.task.findUnique({ where: { id: routeParam(request, 'id') }, include: { incident: { include: { voiceReports: { orderBy: { createdAt: 'asc' }, take: 1 } } }, assignee: true } });
    if (!task) return response.status(404).json({ error: 'Task not found.' });
    const managerAccess = request.user!.role === 'MANAGER' || request.user!.role === 'ADMIN';
    if (task.assigneeId !== request.user!.sub && !managerAccess) return response.status(403).json({ error: 'Only the assignee or a manager can update this task.' });
    if (request.user!.role === 'MANAGER' && task.assigneeId !== request.user!.sub && task.assignee.managerId !== request.user!.sub && task.incident.reporterId !== request.user!.sub) return response.status(403).json({ error: 'You cannot access this task.' });
    const allowed: Record<string, string[]> = { OPEN: ['IN_PROGRESS', 'COMPLETED'], IN_PROGRESS: ['COMPLETED'], OVERDUE: ['IN_PROGRESS', 'COMPLETED'], ESCALATED: ['IN_PROGRESS', 'COMPLETED'], REOPENED: ['IN_PROGRESS', 'COMPLETED'], EMERGENCY: ['IN_PROGRESS', 'COMPLETED'] };
    if (!allowed[task.status]?.includes(parsed.status)) return response.status(409).json({ error: `Cannot move a task from ${task.status} to ${parsed.status}.` });
    if (parsed.status === 'IN_PROGRESS' && !canTransitionIncident(task.incident.status, 'IN_PROGRESS')) return response.status(409).json({ error: `Cannot move an incident from ${task.incident.status} to IN_PROGRESS.` });
    if (parsed.status === 'COMPLETED') {
      const result = await completeTaskForVerification(db, task.id, request.user!.sub);
      return response.json({ task: result.task, verification: result.verification, incidentStatus: result.incidentStatus });
    }
    const updated = await db.$transaction(async (tx) => {
      const newTask = await tx.task.update({ where: { id: task.id }, data: { status: parsed.status } });
      await tx.incident.update({ where: { id: task.incidentId }, data: { status: parsed.status } });
      await tx.auditLog.create({ data: { actorId: request.user!.sub, incidentId: task.incidentId, action: 'TASK_STARTED', reason: 'Status updated by an authorized task owner or manager.', metadata: { taskId: task.id, status: parsed.status } } });
      return newTask;
    });
    if (parsed.status === 'IN_PROGRESS') {
      await db.voiceReport.updateMany({ where: { incidentId: task.incidentId }, data: { status: 'IN_PROGRESS' } });
      await speakStatus({ text: 'Work on your report has started.', language: task.incident.voiceReports[0]?.language ?? null, recipientId: task.incident.reporterId, kind: 'PROGRESS_UPDATE' });
    }
    return response.json({ task: updated });
  }));

  router.post('/tasks/:id/complete', asyncRoute(async (request, response) => {
    if (!requireDb(db, response)) return;
    const task = await db.task.findUnique({ where: { id: routeParam(request, 'id') }, include: { assignee: true, incident: { select: { reporterId: true } } } });
    if (!task) return response.status(404).json({ error: 'Task not found.' });
    if (task.assigneeId !== request.user!.sub && request.user!.role !== 'MANAGER' && request.user!.role !== 'ADMIN') return response.status(403).json({ error: 'Only the assignee or a manager can complete this task.' });
    if (request.user!.role === 'MANAGER' && task.assigneeId !== request.user!.sub && task.assignee.managerId !== request.user!.sub && task.incident.reporterId !== request.user!.sub) return response.status(403).json({ error: 'You cannot access this task.' });
    try {
      const result = await completeTaskForVerification(db, task.id, request.user!.sub);
      return response.json({ task: result.task, verification: result.verification, incidentStatus: result.incidentStatus });
    } catch (error) {
      if (error instanceof Error && error.message.includes('Cannot complete')) return response.status(409).json({ error: error.message });
      throw error;
    }
  }));

  router.post('/tasks/:id/escalate', requireRoles('MANAGER', 'ADMIN'), asyncRoute(async (request, response) => {
    if (!requireDb(db, response)) return;
    const task = await db.task.findUnique({ where: { id: routeParam(request, 'id') }, include: { assignee: true } });
    if (!task) return response.status(404).json({ error: 'Task not found.' });
    if (request.user!.role === 'MANAGER' && task.assignee.managerId !== request.user!.sub && task.assigneeId !== request.user!.sub) return response.status(403).json({ error: 'Managers can escalate tasks in their reporting line.' });
    const input = z.object({ reason: z.string().trim().min(3).max(500).optional() }).safeParse(request.body);
    if (!input.success) return response.status(400).json({ error: 'The escalation reason is invalid.' });
    try {
      const escalation = await sendTaskEscalation(db, task.id, input.data.reason ?? 'A manager requested escalation.');
      return response.status(201).json({ escalation });
    } catch (error) {
      if (error instanceof Error && /No manager|No valid escalation policy|already has|no longer overdue|Only overdue|before its deadline|valid task deadline|Cannot escalate|Incident state changed/u.test(error.message)) return response.status(409).json({ error: error.message });
      throw error;
    }
  }));

  router.post('/incidents/:id/assign', requireRoles('MANAGER', 'ADMIN'), asyncRoute(async (request, response) => {
    if (!requireDb(db, response)) return;
    const input = z.object({ employeeId: z.string().min(1), reason: z.string().max(500).optional() }).parse(request.body);
    const incident = await db.incident.findUnique({ where: { id: routeParam(request, 'id') }, include: { tasks: { include: { assignee: { select: { managerId: true } } } } } });
    const employee = await db.employee.findFirst({ where: { id: input.employeeId, isActive: true } });
    if (!incident || !incident.tasks[0]) return response.status(404).json({ error: 'Incident task not found.' });
    if (request.user!.role === 'MANAGER' && !managerCanAccessIncident(request.user!.sub, incident)) return response.status(403).json({ error: 'You cannot access this incident.' });
    if (!employee) return response.status(400).json({ error: 'Choose an active employee.' });
    const task = incident.tasks[0];
    await db.$transaction(async (tx) => {
      await tx.task.update({ where: { id: task.id }, data: { assigneeId: employee.id } });
      await tx.assignment.create({ data: { taskId: task.id, employeeId: employee.id, assignedById: request.user!.sub, reason: input.reason ?? 'Reassigned by a manager.' } });
      await tx.auditLog.create({ data: { actorId: request.user!.sub, incidentId: incident.id, action: 'INCIDENT_REASSIGNED', reason: input.reason ?? `Reassigned to ${employee.name}.`, metadata: { taskId: task.id, employeeId: employee.id } } });
    });
    await sendNotification(db, { kind: 'ASSIGNMENT', to: employee.email, recipientId: employee.id, subject: `Action required: ${incident.incidentNumber}`, body: incident.description, incidentId: incident.id, taskId: task.id });
    return response.json({ ok: true, assignee: { id: employee.id, name: employee.name, email: employee.email } });
  }));

  router.get('/employees', asyncRoute(async (request, response) => {
    if (!requireDb(db, response)) return;
    const user = await db.employee.findUnique({ where: { id: request.user!.sub } });
    const where = request.user!.role === 'ADMIN' ? { isActive: true } : request.user!.role === 'MANAGER'
      ? { isActive: true, OR: [{ id: user?.id }, { managerId: user?.id }] }
      : { isActive: true, departmentId: user?.departmentId };
    const employees = await db.employee.findMany({ where, select: { id: true, name: true, email: true, role: true, jobTitle: true, department: { select: { name: true } } }, orderBy: { name: 'asc' } });
    return response.json({ employees });
  }));

  router.get('/employees/:id', asyncRoute(async (request, response) => {
    if (!requireDb(db, response)) return;
    const employee = await db.employee.findUnique({ where: { id: routeParam(request, 'id') }, select: { id: true, name: true, email: true, role: true, jobTitle: true, isActive: true, department: { select: { name: true } }, managerId: true } });
    if (!employee) return response.status(404).json({ error: 'Employee not found.' });
    if (request.user!.role !== 'ADMIN' && employee.id !== request.user!.sub && !(request.user!.role === 'MANAGER' && employee.managerId === request.user!.sub)) return response.status(403).json({ error: 'You cannot view this employee.' });
    return response.json({ employee });
  }));

  router.get('/notifications', asyncRoute(async (request, response) => {
    if (!requireDb(db, response)) return;
    const notifications = await db.notification.findMany({ where: { recipientId: request.user!.sub }, orderBy: { createdAt: 'desc' }, take: 100 });
    return response.json({ notifications });
  }));

  router.get('/escalations', requireRoles('MANAGER', 'ADMIN'), asyncRoute(async (request, response) => {
    if (!requireDb(db, response)) return;
    const escalations = await db.escalation.findMany({
      where: request.user!.role === 'ADMIN' ? {} : { managerId: request.user!.sub },
      include: { manager: { select: { id: true, name: true } }, task: { include: { incident: true, assignee: { select: { id: true, name: true } } } } },
      orderBy: { createdAt: 'desc' }
    });
    return response.json({ escalations });
  }));

  router.get('/analytics/overview', requireRoles('MANAGER', 'ADMIN'), asyncRoute(async (_request, response) => {
    if (!requireDb(db, response)) return;
    const [total, open, completed, overdue, escalated, byPriority] = await Promise.all([
      db.incident.count(), db.incident.count({ where: { status: { in: ['OPEN', 'IN_PROGRESS', 'EMERGENCY', 'REOPENED', 'REPORTER_VERIFICATION_PENDING', 'AWAITING_CONFIRMATION'] } } }),
      db.incident.count({ where: { status: 'CLOSED' } }), db.incident.count({ where: { status: 'OVERDUE' } }),
      db.incident.count({ where: { status: 'ESCALATED' } }), db.incident.groupBy({ by: ['priority'], _count: { id: true } })
    ]);
    return response.json({ total, open, completed, overdue, escalated, byPriority });
  }));

  router.get('/audit', requireRoles('ADMIN'), asyncRoute(async (request, response) => {
    if (!requireDb(db, response)) return;
    const events = await db.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 500, include: { actor: { select: { id: true, name: true } }, incident: { select: { id: true, incidentNumber: true, title: true } } } });
    return response.json({ events });
  }));

  return router;
}
