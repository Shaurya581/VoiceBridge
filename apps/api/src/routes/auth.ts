import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import type { DatabaseClient } from '../db.js';
import { hashPassword, issueToken, verifyPassword } from '../auth.js';

const registerSchema = z.object({ name: z.string().trim().min(2).max(120), email: z.string().trim().email().max(254), password: z.string().min(10).max(128), department: z.string().trim().max(100).optional() });
const loginSchema = z.object({ email: z.string().trim().email(), password: z.string().min(1).max(128) });
const googleAuthSchema = z.object({
  credential: z.string().optional(),
  email: z.string().trim().email().optional(),
  name: z.string().trim().max(120).optional()
}).refine((data) => Boolean(data.credential || data.email), {
  message: 'Google credential token or email is required.'
});

function decodeJwtPayload(token: string): { email?: string; name?: string } | null {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    const base64 = parts[1]!.replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(base64, 'base64').toString('utf8');
    return JSON.parse(json) as { email?: string; name?: string };
  } catch {
    return null;
  }
}

export function authRouter(db: DatabaseClient) {
  const router = Router();

  router.post('/register', async (request, response) => {
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: 'Enter a name, valid email, and password of at least 10 characters.', details: parsed.error.flatten() });
    const email = parsed.data.email.toLowerCase();
    const existing = await db.employee.findUnique({ where: { email } });
    if (existing) return response.status(409).json({ error: 'An account already exists for this email.' });
    const department = parsed.data.department ? await db.department.findFirst({ where: { name: { equals: parsed.data.department, mode: 'insensitive' } } }) : null;
    const employee = await db.employee.create({ data: {
      name: parsed.data.name,
      email,
      passwordHash: await hashPassword(parsed.data.password),
      role: 'EMPLOYEE',
      departmentId: department?.id
    } });
    await db.auditLog.create({ data: { actorId: employee.id, action: 'EMPLOYEE_REGISTERED', reason: 'Employee self-registration.' } });
    const user = { id: employee.id, name: employee.name, email: employee.email, role: employee.role, department: department?.name ?? null };
    return response.status(201).json({ user, token: issueToken({ sub: user.id, email: user.email, role: user.role }) });
  });

  router.post('/login', async (request, response) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: 'Enter a valid email and password.' });
    const employee = await db.employee.findUnique({ where: { email: parsed.data.email.toLowerCase() }, include: { department: true } });
    if (!employee || !employee.isActive || !(await verifyPassword(parsed.data.password, employee.passwordHash))) {
      return response.status(401).json({ error: 'Email or password is incorrect.' });
    }
    const user = { id: employee.id, name: employee.name, email: employee.email, role: employee.role, department: employee.department?.name ?? null };
    return response.json({ user, token: issueToken({ sub: user.id, email: user.email, role: user.role }) });
  });

  router.post('/google', async (request, response) => {
    const parsed = googleAuthSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: 'Valid Google credential or email is required.' });

    let email = parsed.data.email;
    let name = parsed.data.name;

    if (parsed.data.credential) {
      const decoded = decodeJwtPayload(parsed.data.credential);
      if (decoded?.email) {
        email = decoded.email;
        name = name ?? decoded.name;
      }
    }

    if (!email) {
      return response.status(400).json({ error: 'Could not extract valid email from Google credentials.' });
    }

    const normalizedEmail = email.toLowerCase().trim();
    let employee = await db.employee.findUnique({
      where: { email: normalizedEmail },
      include: { department: true }
    });

    if (employee && !employee.isActive) {
      return response.status(403).json({ error: 'Account has been deactivated.' });
    }

    if (!employee) {
      const defaultDepartment = await db.department.findFirst({ where: { name: 'Operations' } }) ?? await db.department.findFirst();
      employee = await db.employee.create({
        data: {
          name: name || normalizedEmail.split('@')[0] || 'Google User',
          email: normalizedEmail,
          passwordHash: await hashPassword(randomUUID()),
          role: 'EMPLOYEE',
          departmentId: defaultDepartment?.id
        },
        include: { department: true }
      });
    }

    await db.auditLog.create({
      data: {
        actorId: employee.id,
        action: 'GOOGLE_LOGIN',
        reason: 'Employee signed in via Google SSO.'
      }
    });

    const user = {
      id: employee.id,
      name: employee.name,
      email: employee.email,
      role: employee.role,
      department: employee.department?.name ?? null,
      authProvider: 'google'
    };

    return response.json({
      user,
      token: issueToken({ sub: user.id, email: user.email, role: user.role }),
      authMethod: 'google'
    });
  });

  return router;
}

