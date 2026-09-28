import nodemailer from 'nodemailer';
import type { DatabaseClient } from '../db.js';
import type { Notification } from '../generated/prisma/client.js';

const transporter = process.env.MOCK_EMAIL === 'false'
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT ?? 587),
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } : undefined
    })
  : null;

export interface NotificationProvider {
  send(db: DatabaseClient, input: NotificationInput): Promise<Notification>;
}

export interface NotificationInput {
  kind: string;
  to: string;
  recipientId?: string | null;
  subject: string;
  body: string;
  incidentId?: string | null;
  taskId?: string | null;
}

export class ConfiguredNotificationProvider implements NotificationProvider {
  send(db: DatabaseClient, input: NotificationInput) { return sendNotification(db, input); }
}

export async function sendNotification(db: DatabaseClient, input: NotificationInput): Promise<Notification> {
  const record = await db.notification.create({ data: {
    kind: input.kind,
    recipientEmail: input.to,
    recipientId: input.recipientId ?? null,
    subject: input.subject,
    body: input.body,
    incidentId: input.incidentId ?? null,
    taskId: input.taskId ?? null,
    status: 'PENDING'
  } });

  if (!transporter || process.env.MOCK_EMAIL !== 'false') {
    return db.notification.update({ where: { id: record.id }, data: { status: 'SENT', sentAt: new Date() } });
  }

  try {
    await transporter.sendMail({
      from: process.env.EMAIL_FROM ?? 'voicebridge@example.com',
      to: input.to,
      subject: input.subject,
      text: input.body
    });
    return await db.notification.update({ where: { id: record.id }, data: { status: 'SENT', sentAt: new Date() } });
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : 'Email delivery failed';
    return db.notification.update({ where: { id: record.id }, data: { status: 'FAILED', error: message } });
  }
}
