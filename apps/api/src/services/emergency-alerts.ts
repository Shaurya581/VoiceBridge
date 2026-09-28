import type { DatabaseClient } from '../db.js';
import { notificationProvider, type NotificationProvider } from './email.js';
import { emergencyAlertProvider, type EmergencyAlertProvider } from './voice-feedback.js';

const alertMaxAttempts = () => {
  const configured = Number(process.env.EMERGENCY_ALERT_MAX_ATTEMPTS ?? 3);
  return Number.isInteger(configured) && configured > 0 ? configured : 3;
};

function contactIdFromMetadata(metadata: unknown) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined;
  const contactId = (metadata as Record<string, unknown>).contactId;
  return typeof contactId === 'string' && contactId ? contactId : undefined;
}

export async function dispatchEmergencyAlert(
  db: DatabaseClient,
  eventId: string,
  now = new Date(),
  provider: EmergencyAlertProvider = emergencyAlertProvider(),
  notifications: NotificationProvider = notificationProvider()
) {
  const event = await db.emergencyEvent.findUnique({ where: { id: eventId }, include: { incident: true } });
  if (!event) return { attempted: false, delivered: false };

  const claim = await db.emergencyEvent.updateMany({
    where: { id: event.id, status: { in: ['PENDING', 'FAILED'] }, attemptCount: { lt: alertMaxAttempts() } },
    data: { status: 'PROCESSING', attemptCount: { increment: 1 }, lastAttemptAt: now }
  });
  if (!claim.count) return { attempted: false, delivered: false };

  const contactId = contactIdFromMetadata(event.metadata);
  const contact = contactId ? await db.employee.findUnique({ where: { id: contactId }, select: { id: true, email: true } }) : null;
  let result: Awaited<ReturnType<EmergencyAlertProvider['alert']>>;
  try {
    result = await provider.alert({
      incidentId: event.incident.id,
      incidentNumber: event.incident.incidentNumber,
      reason: event.reason,
      recipientId: contact?.id,
      recipient: contact?.email
    });
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : 'Emergency alert provider failed';
    await db.$transaction(async (tx) => {
      await tx.emergencyEvent.updateMany({ where: { id: event.id, status: 'PROCESSING' }, data: { status: 'FAILED' } });
      await tx.incident.update({ where: { id: event.incidentId }, data: { emergencyStatus: 'ALERT_FAILED' } });
      await tx.auditLog.create({ data: {
        actorId: null, incidentId: event.incidentId, action: 'EMERGENCY_ALERT_FAILED',
        reason: 'Emergency alert dispatch failed; the worker may retry within the configured attempt limit.',
        metadata: { emergencyEventId: event.id, attemptCount: event.attemptCount + 1, error: message }
      } });
    });
    return { attempted: true, delivered: false, error: message };
  }

  const status = result.status === 'PENDING' ? 'QUEUED' : 'SIMULATED';
  await db.$transaction(async (tx) => {
    await tx.emergencyEvent.updateMany({ where: { id: event.id, status: 'PROCESSING' }, data: { status, alertedAt: now } });
    await tx.incident.update({ where: { id: event.incidentId }, data: { emergencyStatus: status } });
    await tx.auditLog.create({ data: {
      actorId: null,
      incidentId: event.incidentId,
      action: 'EMERGENCY_ALERT_DISPATCHED',
      reason: result.status === 'PENDING' ? 'Emergency alert was accepted by the configured provider and is pending delivery.' : 'Mock emergency alert was recorded by the configured provider.',
      metadata: { emergencyEventId: event.id, providerStatus: result.status, attemptCount: event.attemptCount + 1, recipientId: contact?.id ?? null }
    } });
  });
  if (contact) {
    try {
      const notice = await notifications.send(db, {
        kind: 'EMERGENCY_ALERT', to: contact.email, recipientId: contact.id,
        subject: `IMMEDIATE SAFETY ALERT: ${event.incident.incidentNumber}`,
        body: `${event.reason}\n${event.incident.title}\n${event.incident.location ?? 'Location not provided'}`,
        incidentId: event.incidentId
      });
      if (notice.status === 'FAILED') await db.auditLog.create({ data: {
        actorId: null, incidentId: event.incidentId, action: 'EMERGENCY_NOTIFICATION_FAILED',
        reason: 'The emergency alert provider was invoked, but the separate email notification failed.',
        metadata: { emergencyEventId: event.id, notificationId: notice.id }
      } });
    } catch (error) {
      await db.auditLog.create({ data: {
        actorId: null, incidentId: event.incidentId, action: 'EMERGENCY_NOTIFICATION_FAILED',
        reason: 'Emergency alert was dispatched, but email notification raised an error.',
        metadata: { emergencyEventId: event.id, error: error instanceof Error ? error.message.slice(0, 500) : 'unknown error' }
      } });
    }
  }
  return { attempted: true, delivered: true, status };
}
