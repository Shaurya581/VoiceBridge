import { randomUUID } from 'node:crypto';
import cors from 'cors';
import express, { type ErrorRequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import multer from 'multer';
import type { DatabaseClient } from './db.js';
import { authRouter } from './routes/auth.js';
import { apiRouter } from './routes/api.js';

export function createApp(database: DatabaseClient | null = null) {
  const app = express();
  app.disable('x-powered-by');
  app.use((request, response, next) => {
    const requestId = randomUUID();
    response.setHeader('x-request-id', requestId);
    response.locals.requestId = requestId;
    next();
  });
  app.use(helmet());
  app.use(cors({ origin: process.env.WEB_ORIGIN ?? 'http://localhost:5173' }));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));

  app.get('/api/health', async (_request, response) => {
    let databaseStatus: 'connected' | 'unconfigured' | 'unavailable' = 'unconfigured';
    if (database) {
      try {
        await database.$queryRawUnsafe('SELECT 1');
        databaseStatus = 'connected';
      } catch {
        databaseStatus = 'unavailable';
      }
    }
    const healthy = databaseStatus !== 'unavailable';
    response.status(healthy ? 200 : 503).json({
      status: healthy ? 'ok' : 'degraded',
      service: 'voicebridge-api',
      database: databaseStatus,
      timestamp: new Date().toISOString(),
      requestId: response.locals.requestId
    });
  });

  app.get('/api/openapi.json', (_request, response) => response.json(openApiDocument));
  app.use('/api/auth', rateLimit({ windowMs: 15 * 60_000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false }));
  if (database) {
    app.use('/api/auth', authRouter(database));
    app.use('/api', apiRouter(database));
  } else {
    app.use('/api/auth', (_request, response) => response.status(503).json({ error: 'The database is not configured.' }));
    app.use('/api', (_request, response) => response.status(503).json({ error: 'The database is not configured.' }));
  }
  app.use((_request, response) => response.status(404).json({ error: 'Route not found.' }));

  const errors: ErrorRequestHandler = (error, _request, response, _next) => {
    if (error instanceof multer.MulterError) {
      const tooLarge = error.code === 'LIMIT_FILE_SIZE';
      return response.status(tooLarge ? 413 : 400).json({ error: tooLarge ? 'Audio must be 25 MB or smaller.' : 'The audio upload is invalid.' });
    }
    const requestId = response.locals.requestId;
    console.error(JSON.stringify({ event: 'request_failed', requestId, message: error instanceof Error ? error.message : 'unknown error' }));
    return response.status(500).json({ error: 'The request could not be completed.', requestId });
  };
  app.use(errors);
  return app;
}

const openApiDocument = {
  openapi: '3.1.0',
  info: { title: 'VoiceBridge API', version: '0.1.0', description: 'Voice report intake and incident workflow API.' },
  servers: [{ url: 'http://localhost:4000' }],
  paths: {
    '/api/health': { get: { summary: 'Health and database connectivity', responses: { '200': { description: 'Healthy' }, '503': { description: 'Database unavailable' } } } },
    '/api/auth/login': { post: { summary: 'Create a session', responses: { '200': { description: 'Signed in' } } } },
    '/api/auth/register': { post: { summary: 'Register an employee', responses: { '201': { description: 'Account created' } } } },
    '/api/voice/upload': { post: { summary: 'Submit audio and transcript', security: [{ bearerAuth: [] }], responses: { '201': { description: 'Incident and task created' }, '202': { description: 'Human confirmation required' } } } },
    '/api/incidents': { get: { summary: 'List incidents visible to the current user', security: [{ bearerAuth: [] }], responses: { '200': { description: 'Incident list' } } } },
    '/api/tasks': { get: { summary: 'List tasks visible to the current user', security: [{ bearerAuth: [] }], responses: { '200': { description: 'Task list' } } } },
    '/api/tasks/{id}/complete': { post: { summary: 'Complete a task and request spoken reporter verification', security: [{ bearerAuth: [] }], responses: { '200': { description: 'Task completion recorded; incident awaits reporter verification' } } } },
    '/api/incidents/{id}/verify-closure': { post: { summary: 'Record the original reporter response for a specific verification request', security: [{ bearerAuth: [] }], responses: { '200': { description: 'Verification recorded; incident closed or reopened' }, '403': { description: 'Only the original reporter may respond' }, '404': { description: 'Verification request not found for this incident' } } } }
  },
  components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } } }
};
