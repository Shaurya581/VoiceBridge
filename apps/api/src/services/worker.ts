import type { DatabaseClient } from '../db.js';
import { sendNotification } from './email.js';

export async function sendTaskEscalation(db: DatabaseClient, taskId: string, reason = 'The task is past its deadline.') {
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
  if (['COMPLETED', 'CLOSED'].includes(task.status)) throw new Error('Completed tasks cannot be escalated');
  const manager = task.assignee.manager ?? task.assignee.department?.employees.find((candidate) => candidate.id !== task.assigneeId);
  if (!manager) throw new Error('No manager is configured for this task');
  const level = (task.escalations[0]?.level ?? 0) + 1;
  const escalation = await db.$transaction(async (tx) => {
    const record = await tx.escalation.create({ data: { taskId: task.id, managerId: manager.id, level, reason } });
    await tx.task.update({ where: { id: task.id }, data: { status: 'ESCALATED' } });
    await tx.incident.update({ where: { id: task.incidentId }, data: { status: 'ESCALATED' } });
    await tx.auditLog.create({ data: { actorId: null, incidentId: task.incidentId, action: 'TASK_ESCALATED', reason, metadata: { taskId: task.id, managerId: manager.id, level } } });
    return record;
  });
  await sendNotification(db, { kind: 'ESCALATION', to: manager.email, recipientId: manager.id, subject: `Overdue task escalated: ${task.incident.incidentNumber}`, body: `${task.title}\n\n${reason}\nOriginal deadline: ${task.deadline.toLocaleString()}`, incidentId: task.incidentId, taskId: task.id });
  return escalation;
}

export async function runDeadlineSweep(db: DatabaseClient, now = new Date()) {
  let remindersSent = 0;
  let tasksOverdue = 0;
  let tasksEscalated = 0;
  const dueReminders = await db.reminder.findMany({
    where: { status: 'PENDING', scheduledAt: { lte: now } },
    include: { task: { include: { incident: true, assignee: true } } },
    orderBy: { scheduledAt: 'asc' }, take: 100
  });
  for (const reminder of dueReminders) {
    if (['COMPLETED', 'CLOSED'].includes(reminder.task.status)) {
      await db.reminder.update({ where: { id: reminder.id }, data: { status: 'FAILED' } });
      continue;
    }
    const claimed = await db.reminder.updateMany({ where: { id: reminder.id, status: 'PENDING' }, data: { status: 'SENT', sentAt: now } });
    if (!claimed.count) continue;
    await sendNotification(db, {
      kind: 'REMINDER', to: reminder.task.assignee.email, recipientId: reminder.task.assigneeId,
      subject: `Reminder: ${reminder.task.incident.incidentNumber} is due soon`,
      body: `Please update “${reminder.task.title}”. Deadline: ${reminder.task.deadline.toLocaleString()}.`,
      incidentId: reminder.task.incidentId, taskId: reminder.taskId
    });
    await db.auditLog.create({ data: { actorId: null, incidentId: reminder.task.incidentId, action: 'REMINDER_SENT', reason: 'Scheduled task reminder.', metadata: { taskId: reminder.taskId, reminderId: reminder.id } } });
    remindersSent += 1;
  }

  const overdue = await db.task.findMany({
    where: { status: { in: ['OPEN', 'IN_PROGRESS'] }, deadline: { lt: now } },
    include: { incident: true }
  });
  for (const task of overdue) {
    const claimed = await db.task.updateMany({ where: { id: task.id, status: { in: ['OPEN', 'IN_PROGRESS'] } }, data: { status: 'OVERDUE' } });
    if (!claimed.count) continue;
    await db.incident.update({ where: { id: task.incidentId }, data: { status: 'OVERDUE' } });
    await db.auditLog.create({ data: { actorId: null, incidentId: task.incidentId, action: 'TASK_OVERDUE', reason: 'The configured deadline has passed.', metadata: { taskId: task.id, deadline: task.deadline.toISOString() } } });
    tasksOverdue += 1;
  }

  const eligible = await db.task.findMany({
    where: { status: 'OVERDUE', deadline: { lt: now } },
    include: { incident: true, escalations: true }
  });
  for (const task of eligible) {
    const rules = await db.escalationRule.findMany({ where: { enabled: true }, include: { department: true }, orderBy: { escalateAfterMinutes: 'asc' } });
    const rule = rules.find((candidate) =>
      (!candidate.department || candidate.department.name.toLowerCase() === (task.incident.responsibleDepartment ?? '').toLowerCase()) &&
      (!candidate.priority || candidate.priority === task.incident.priority)
    );
    const escalateAfter = rule?.escalateAfterMinutes ?? 0;
    if (task.deadline.getTime() + escalateAfter * 60_000 > now.getTime()) continue;
    if (task.escalations.some((item) => item.reason === 'The task is past its deadline.')) continue;
    try {
      await sendTaskEscalation(db, task.id);
      tasksEscalated += 1;
    } catch (error) {
      console.error(JSON.stringify({ event: 'escalation_failed', taskId: task.id, message: error instanceof Error ? error.message : 'unknown error' }));
    }
  }
  return { remindersSent, tasksOverdue, tasksEscalated };
}

export function startDeadlineWorker(db: DatabaseClient, intervalMs = 60_000) {
  let running = false;
  const sweep = async () => {
    if (running) return;
    running = true;
    try {
      const result = await runDeadlineSweep(db);
      if (result.remindersSent || result.tasksOverdue || result.tasksEscalated) console.info(JSON.stringify({ event: 'deadline_sweep', ...result }));
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
