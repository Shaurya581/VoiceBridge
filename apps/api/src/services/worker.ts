import type { DatabaseClient } from '../db.js';
import { notificationProvider, type NotificationProvider } from './email.js';
import { dispatchEmergencyAlert } from './emergency-alerts.js';
import { canTransitionIncident } from './safety.js';
import type { EmergencyAlertProvider } from './voice-feedback.js';
import { isValidDeadline, selectEscalationPolicy } from './workflow-policy.js';

const maxReminderAttempts = () => {
  const configured = Number(process.env.REMINDER_MAX_ATTEMPTS ?? 3);
  return Number.isInteger(configured) && configured > 0 ? configured : 3;
};

const maxEmergencyAlertAttempts = () => {
  const configured = Number(process.env.EMERGENCY_ALERT_MAX_ATTEMPTS ?? 3);
  return Number.isInteger(configured) && configured > 0 ? configured : 3;
};

function leaseCutoff(now: Date) {
  return new Date(now.getTime() - Number(process.env.WORKFLOW_CLAIM_LEASE_MS ?? 5 * 60_000));
}

async function applicableEscalationPolicy(db: DatabaseClient, incident: { responsibleDepartment: string | null; priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' }) {
  const policies = await db.escalationRule.findMany({ where: { enabled: true }, include: { department: true } });
  return selectEscalationPolicy(policies, incident.responsibleDepartment, incident.priority);
}

export async function sendTaskEscalation(
  db: DatabaseClient,
  taskId: string,
  reason = 'The task is past its configured escalation threshold.',
  now = new Date(),
  notifications: NotificationProvider = notificationProvider()
) {
  const task = await db.task.findUnique({
    where: { id: taskId },
    include: {
      incident: true,
      assignee: {
        include: {
          manager: true,
          department: { include: { employees: { where: { role: { in: ['MANAGER', 'ADMIN'] }, isActive: true } } } }
        }
      },
      escalations: { orderBy: { level: 'desc' } }
    }
  });
  if (!task) throw new Error('Task not found');
  if (task.incident.isEmergency || task.incident.status === 'EMERGENCY') throw new Error('Emergency incidents bypass normal escalation');
  if (!isValidDeadline(task.deadline)) throw new Error('A valid task deadline is required for escalation');
  if (task.deadline.getTime() > now.getTime()) throw new Error('A task cannot be escalated before its deadline');
  if (task.status !== 'OVERDUE') throw new Error('Only overdue tasks can be escalated');
  if (task.escalations.length) throw new Error('This task already has its one escalation');
  if (!canTransitionIncident(task.incident.status, 'ESCALATED')) throw new Error(`Cannot escalate an incident from ${task.incident.status}`);
  const policy = await applicableEscalationPolicy(db, task.incident);
  if (!policy || !Number.isInteger(policy.escalateAfterMinutes) || policy.escalateAfterMinutes < 0) throw new Error('No valid escalation policy is configured for this incident');
  const manager = task.assignee.manager ?? task.assignee.department?.employees.find((candidate) => candidate.id !== task.assigneeId);
  if (!manager) throw new Error('No manager is configured for this task');

  const escalation = await db.$transaction(async (tx) => {
    const claim = await tx.task.updateMany({
      where: { id: task.id, status: 'OVERDUE', escalations: { none: {} } },
      data: { status: 'ESCALATED' }
    });
    if (!claim.count) throw new Error('This task was already escalated or is no longer overdue');
    const incidentClaim = await tx.incident.updateMany({
      where: { id: task.incidentId, status: task.incident.status },
      data: { status: 'ESCALATED' }
    });
    if (!incidentClaim.count) throw new Error('Incident state changed before escalation');
    await tx.voiceReport.updateMany({ where: { incidentId: task.incidentId }, data: { status: 'ESCALATED' } });
    const record = await tx.escalation.create({ data: { taskId: task.id, managerId: manager.id, level: 1, reason } });
    await tx.auditLog.create({ data: {
      actorId: null,
      incidentId: task.incidentId,
      action: 'TASK_ESCALATED',
      reason,
      metadata: { taskId: task.id, managerId: manager.id, level: 1, policyId: policy.id, deadline: task.deadline.toISOString() }
    } });
    return record;
  });

  try {
    const notice = await notifications.send(db, {
      kind: 'ESCALATION', to: manager.email, recipientId: manager.id,
      subject: `Overdue task escalated: ${task.incident.incidentNumber}`,
      body: `${task.title}\n\n${reason}\nOriginal deadline: ${task.deadline.toLocaleString()}`,
      incidentId: task.incidentId, taskId: task.id
    });
    if (notice.status === 'FAILED') await db.auditLog.create({ data: {
      actorId: null, incidentId: task.incidentId, action: 'ESCALATION_NOTIFICATION_FAILED',
      reason: 'The task escalation was recorded, but its manager notification failed.',
      metadata: { taskId: task.id, escalationId: escalation.id, notificationId: notice.id }
    } });
  } catch (error) {
    await db.auditLog.create({ data: {
      actorId: null, incidentId: task.incidentId, action: 'ESCALATION_NOTIFICATION_FAILED',
      reason: 'The task escalation was recorded, but notification dispatch raised an error.',
      metadata: { taskId: task.id, escalationId: escalation.id, error: error instanceof Error ? error.message.slice(0, 500) : 'unknown error' }
    } });
  }
  return escalation;
}

export async function runDeadlineSweep(
  db: DatabaseClient,
  now = new Date(),
  dependencies: { notifications?: NotificationProvider; emergencyAlerts?: EmergencyAlertProvider } = {}
) {
  const notifications = dependencies.notifications ?? notificationProvider();
  const emergencyAlerts = dependencies.emergencyAlerts;
  let remindersSent = 0;
  let remindersFailed = 0;
  let tasksOverdue = 0;
  let tasksEscalated = 0;
  let emergencyAlertsAttempted = 0;
  let emergencyAlertsFailed = 0;

  await db.reminder.updateMany({
    where: { status: 'PROCESSING', lastAttemptAt: { lt: leaseCutoff(now) } },
    data: { status: 'FAILED' }
  });
  await db.emergencyEvent.updateMany({
    where: { status: 'PROCESSING', lastAttemptAt: { lt: leaseCutoff(now) } },
    data: { status: 'FAILED' }
  });

  const pendingAlerts = await db.emergencyEvent.findMany({
    where: { kind: 'IMMEDIATE_ALERT', status: { in: ['PENDING', 'FAILED'] }, attemptCount: { lt: maxEmergencyAlertAttempts() } },
    orderBy: { triggeredAt: 'asc' }, take: 100
  });
  for (const event of pendingAlerts) {
    try {
      const result = await dispatchEmergencyAlert(db, event.id, now, emergencyAlerts, notifications);
      if (result.attempted) emergencyAlertsAttempted += 1;
      if (result.attempted && !result.delivered) emergencyAlertsFailed += 1;
    } catch (error) {
      emergencyAlertsFailed += 1;
      console.error(JSON.stringify({ event: 'emergency_alert_retry_failed', emergencyEventId: event.id, message: error instanceof Error ? error.message : 'unknown error' }));
    }
  }

  const dueReminders = await db.reminder.findMany({
    where: { status: { in: ['PENDING', 'FAILED'] }, attemptCount: { lt: maxReminderAttempts() }, scheduledAt: { lte: now } },
    include: { task: { include: { incident: true, assignee: true } } },
    orderBy: { scheduledAt: 'asc' }, take: 100
  });
  for (const reminder of dueReminders) {
    const task = reminder.task;
    const skipReason = task.incident.isEmergency || task.incident.status === 'EMERGENCY'
      ? 'Emergency incidents bypass normal reminders.'
      : ['COMPLETED', 'CLOSED', 'ESCALATED', 'OVERDUE'].includes(task.status)
        ? `Task is already ${task.status.toLocaleLowerCase()}.`
        : !isValidDeadline(task.deadline)
          ? 'Task has no valid configured deadline.'
          : task.deadline.getTime() <= now.getTime()
            ? 'The reminder was not delivered before its deadline.'
            : null;
    if (skipReason) {
      await db.$transaction(async (tx) => {
        await tx.reminder.updateMany({ where: { id: reminder.id, status: { in: ['PENDING', 'FAILED'] } }, data: { status: 'FAILED', attemptCount: maxReminderAttempts() } });
        await tx.auditLog.create({ data: {
          actorId: null, incidentId: task.incidentId,
          action: task.incident.isEmergency || task.incident.status === 'EMERGENCY' ? 'EMERGENCY_REMINDER_BYPASSED' : 'REMINDER_SKIPPED',
          reason: skipReason, metadata: { reminderId: reminder.id, taskId: task.id }
        } });
      });
      continue;
    }

    const claimed = await db.reminder.updateMany({
      where: { id: reminder.id, status: { in: ['PENDING', 'FAILED'] }, attemptCount: { lt: maxReminderAttempts() } },
      data: { status: 'PROCESSING', attemptCount: { increment: 1 }, lastAttemptAt: now }
    });
    if (!claimed.count) continue;
    try {
      const notice = await notifications.send(db, {
        kind: 'REMINDER', to: task.assignee.email, recipientId: task.assigneeId,
        subject: `Reminder: ${task.incident.incidentNumber} is due soon`,
        body: `Please update “${task.title}”. Deadline: ${task.deadline.toLocaleString()}.`,
        incidentId: task.incidentId, taskId: reminder.taskId
      });
      const sent = notice.status === 'SENT';
      await db.$transaction(async (tx) => {
        await tx.reminder.update({ where: { id: reminder.id }, data: { status: sent ? 'SENT' : 'FAILED', ...(sent ? { sentAt: now } : {}) } });
        await tx.auditLog.create({ data: {
          actorId: null, incidentId: task.incidentId,
          action: sent ? 'REMINDER_SENT' : 'REMINDER_DELIVERY_FAILED',
          reason: sent ? 'Scheduled reminder delivered through the configured notification provider.' : 'The configured notification provider reported reminder delivery failure.',
          metadata: { taskId: task.id, reminderId: reminder.id, notificationId: notice.id, attemptCount: reminder.attemptCount + 1 }
        } });
      });
      if (sent) remindersSent += 1;
      else remindersFailed += 1;
    } catch (error) {
      remindersFailed += 1;
      await db.$transaction(async (tx) => {
        await tx.reminder.updateMany({ where: { id: reminder.id, status: 'PROCESSING' }, data: { status: 'FAILED' } });
        await tx.auditLog.create({ data: {
          actorId: null, incidentId: task.incidentId, action: 'REMINDER_DELIVERY_FAILED',
          reason: 'The notification provider raised an error; the reminder remains eligible for a bounded retry.',
          metadata: { taskId: task.id, reminderId: reminder.id, attemptCount: reminder.attemptCount + 1, error: error instanceof Error ? error.message.slice(0, 500) : 'unknown error' }
        } });
      });
    }
  }

  const overdue = await db.task.findMany({
    where: { status: { in: ['OPEN', 'IN_PROGRESS'] }, deadline: { lte: now }, incident: { isEmergency: false } },
    include: { incident: true }
  });
  for (const task of overdue) {
    if (!isValidDeadline(task.deadline) || task.incident.status === 'EMERGENCY' || !canTransitionIncident(task.incident.status, 'OVERDUE')) continue;
    try {
      const changed = await db.$transaction(async (tx) => {
        const taskClaim = await tx.task.updateMany({ where: { id: task.id, status: { in: ['OPEN', 'IN_PROGRESS'] }, deadline: { lte: now } }, data: { status: 'OVERDUE' } });
        if (!taskClaim.count) return false;
        const incidentClaim = await tx.incident.updateMany({ where: { id: task.incidentId, status: task.incident.status }, data: { status: 'OVERDUE' } });
        if (!incidentClaim.count) throw new Error('Incident state changed before overdue transition');
        await tx.voiceReport.updateMany({ where: { incidentId: task.incidentId }, data: { status: 'OVERDUE' } });
        await tx.auditLog.create({ data: {
          actorId: null, incidentId: task.incidentId, action: 'TASK_OVERDUE',
          reason: 'The configured task deadline has passed.',
          metadata: { taskId: task.id, deadline: task.deadline.toISOString() }
        } });
        return true;
      });
      if (changed) tasksOverdue += 1;
    } catch (error) {
      console.error(JSON.stringify({ event: 'task_overdue_transition_failed', taskId: task.id, message: error instanceof Error ? error.message : 'unknown error' }));
    }
  }

  const eligible = await db.task.findMany({
    where: { status: 'OVERDUE', deadline: { lte: now }, incident: { isEmergency: false }, escalations: { none: {} } },
    include: { incident: true, escalations: true }
  });
  for (const task of eligible) {
    if (!isValidDeadline(task.deadline) || task.incident.status === 'EMERGENCY') continue;
    try {
      const policy = await applicableEscalationPolicy(db, task.incident);
      if (!policy || !Number.isInteger(policy.escalateAfterMinutes) || policy.escalateAfterMinutes < 0) continue;
      if (task.deadline.getTime() + policy.escalateAfterMinutes * 60_000 > now.getTime()) continue;
      await sendTaskEscalation(db, task.id, 'The task passed its configured escalation threshold.', now, notifications);
      tasksEscalated += 1;
    } catch (error) {
      console.error(JSON.stringify({ event: 'escalation_failed', taskId: task.id, message: error instanceof Error ? error.message : 'unknown error' }));
    }
  }
  return { remindersSent, remindersFailed, tasksOverdue, tasksEscalated, emergencyAlertsAttempted, emergencyAlertsFailed };
}

export function startDeadlineWorker(db: DatabaseClient, intervalMs = 60_000) {
  let running = false;
  const sweep = async () => {
    if (running) return;
    running = true;
    try {
      const result = await runDeadlineSweep(db);
      if (Object.values(result).some((value) => value > 0)) console.info(JSON.stringify({ event: 'deadline_sweep', ...result }));
    } catch (error) {
      console.error(JSON.stringify({ event: 'deadline_sweep_failed', message: error instanceof Error ? error.message : 'unknown error' }));
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void sweep(), intervalMs);
  timer.unref();
  void sweep();
  return () => clearInterval(timer);
}
