import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { NextFunction, Request, Response } from 'express';
import type { Role } from './generated/prisma/enums.js';

export interface SessionClaims {
  sub: string;
  role: Role;
  email: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: SessionClaims;
    }
  }
}

function jwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV === 'production') throw new Error('JWT_SECRET must be configured in production');
  return 'voicebridge-local-development-secret-change-before-deployment';
}

export async function hashPassword(password: string) {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, hash: string) {
  return bcrypt.compare(password, hash);
}

export function issueToken(user: SessionClaims) {
  return jwt.sign(user, jwtSecret(), { expiresIn: '12h', issuer: 'voicebridge' });
}

export function requireAuth(request: Request, response: Response, next: NextFunction) {
  const header = request.header('authorization');
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return response.status(401).json({ error: 'Authentication required' });
  try {
    request.user = jwt.verify(token, jwtSecret(), { issuer: 'voicebridge' }) as SessionClaims;
    next();
  } catch {
    return response.status(401).json({ error: 'Session is invalid or expired' });
  }
}

export function requireRoles(...roles: Role[]) {
  return (request: Request, response: Response, next: NextFunction) => {
    if (!request.user) return response.status(401).json({ error: 'Authentication required' });
    if (!roles.includes(request.user.role)) return response.status(403).json({ error: 'You do not have access to this action' });
    next();
  };
}

