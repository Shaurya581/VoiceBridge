import { describe, expect, it, vi } from 'vitest';
import { issueToken } from '../auth.js';
import type { DatabaseClient } from '../db.js';
import { createApp } from '../app.js';

async function withApi(database: DatabaseClient, run: (url: string) => Promise<void>) {
  const server = createApp(database).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind a TCP port');
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

const tokenFor = (sub: string, role: 'EMPLOYEE' | 'MANAGER' | 'ADMIN') => issueToken({ sub, role, email: `${sub}@example.test` });

describe('VoiceBridge Task completion and existing record lifecycle', () => {
  const reporterId = 'reporter-1';
  const assigneeId = 'assignee-1';
  const incidentId = 'incident-123';
  const taskId = 'task-456';
  const verificationId = 'verification-789';

  it('A. Existing task is displayed via GET /api/tasks with correct status and relations', async () => {
    const existingTask = {
      id: taskId,
      title: 'Fix Machine 4 abnormal noise',
      description: 'Check bearings on packaging line',
      status: 'IN_PROGRESS',
      deadline: new Date('2026-10-04T12:00:00.000Z'),
      assigneeId,
      assignee: { id: assigneeId, name: 'Maintenance Technician', email: 'tech@example.test' },
      incident: {
        id: incidentId,
        incidentNumber: 'INC-123',
        title: 'Fix Machine 4 abnormal noise',
        location: 'packaging line',
        priority: 'HIGH',
        status: 'IN_PROGRESS'
      }
    };

    const database = {
      task: {
        findMany: vi.fn().mockResolvedValue([existingTask])
      }
    } as unknown as DatabaseClient;

    await withApi(database, async (url) => {
      const response = await fetch(`${url}/api/tasks`, {
        headers: { authorization: `Bearer ${tokenFor(assigneeId, 'EMPLOYEE')}` }
      });
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.tasks).toHaveLength(1);
      expect(data.tasks[0]).toMatchObject({
        id: taskId,
        title: 'Fix Machine 4 abnormal noise',
        status: 'IN_PROGRESS',
        assignee: { id: assigneeId, name: 'Maintenance Technician' }
      });
    });
  });

  it('B, C, D, E, F, G. Complete Task updates THAT existing record, preserves ID, creates NO duplicate, transitions incident, and creates audit trail', async () => {
    const now = new Date('2026-10-03T10:00:00.000Z');
    const existingTask = {
      id: taskId,
      incidentId,
      assigneeId,
      status: 'IN_PROGRESS',
      title: 'Fix Machine 4 abnormal noise',
      deadline: new Date('2026-10-04T12:00:00.000Z'),
      assignee: { id: assigneeId, name: 'Maintenance Technician', email: 'tech@example.test', managerId: null },
      incident: {
        id: incidentId,
        incidentNumber: 'INC-123',
        title: 'Fix Machine 4 abnormal noise',
        asset: 'Machine 4',
        location: 'packaging line',
        priority: 'HIGH',
        status: 'IN_PROGRESS',
        reporterId,
        voiceReports: [{ language: 'hi', createdAt: now }]
      }
    };

    const updatedTask = {
      ...existingTask,
      status: 'COMPLETED_BY_ASSIGNEE',
      completedAt: now
    };

    const verificationRecord = {
      id: verificationId,
      incidentId,
      reporterId,
      status: 'PENDING',
      deliveryMode: 'MOCK',
      deliveryStatus: 'PENDING',
      attemptCount: 0,
      language: 'hi',
      prompt: 'Machine 4 की समस्या ठीक बताई गई है।'
    };

    const taskCreateSpy = vi.fn();
    const taskUpdateManySpy = vi.fn().mockResolvedValue({ count: 1 });
    const incidentUpdateManySpy = vi.fn().mockResolvedValue({ count: 1 });
    const auditCreateManySpy = vi.fn().mockResolvedValue({ count: 2 });
    const auditCreateSpy = vi.fn().mockResolvedValue({});

    const tx = {
      task: {
        create: taskCreateSpy,
        updateMany: taskUpdateManySpy,
        findUnique: vi.fn().mockResolvedValue(updatedTask)
      },
      incident: {
        updateMany: incidentUpdateManySpy
      },
      voiceReport: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 })
      },
      closureVerification: {
        count: vi.fn().mockResolvedValue(0),
        create: vi.fn().mockResolvedValue(verificationRecord),
        updateMany: vi.fn().mockResolvedValue({ count: 1 })
      },
      auditLog: {
        createMany: auditCreateManySpy,
        create: auditCreateSpy
      }
    };

    const database = {
      task: {
        findUnique: vi.fn().mockResolvedValue(existingTask)
      },
      employee: {
        findUnique: vi.fn().mockResolvedValue({ id: reporterId, name: 'Operator' })
      },
      closureVerification: {
        findUnique: vi.fn().mockResolvedValue(verificationRecord)
      },
      incident: {
        findUnique: vi.fn().mockResolvedValue({ id: incidentId, status: 'REPORTER_VERIFICATION_PENDING' })
      },
      auditLog: {
        create: auditCreateSpy
      },
      $transaction: vi.fn((callback: (txArg: typeof tx) => unknown) => callback(tx))
    } as unknown as DatabaseClient;

    await withApi(database, async (url) => {
      const response = await fetch(`${url}/api/tasks/${taskId}/complete`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${tokenFor(assigneeId, 'EMPLOYEE')}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({})
      });

      expect(response.status).toBe(200);
      const data = await response.json();

      // B & C. Existing task was updated and Task ID remains strictly unchanged
      expect(data.task.id).toBe(taskId);
      expect(taskUpdateManySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: taskId }),
          data: expect.objectContaining({ status: 'COMPLETED_BY_ASSIGNEE' })
        })
      );

      // D. No duplicate task was created
      expect(taskCreateSpy).not.toHaveBeenCalled();

      // E. Task status changed to COMPLETED_BY_ASSIGNEE
      expect(data.task.status).toBe('COMPLETED_BY_ASSIGNEE');

      // F. Incident transitions to REPORTER_VERIFICATION_PENDING
      expect(data.incidentStatus).toBe('REPORTER_VERIFICATION_PENDING');
      expect(incidentUpdateManySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: incidentId }),
          data: expect.objectContaining({
            status: 'REPORTER_VERIFICATION_PENDING',
            reporterVerificationStatus: 'PENDING'
          })
        })
      );

      // G. Audit event is created with required metadata
      expect(auditCreateManySpy).toHaveBeenCalledWith({
        data: expect.arrayContaining([
          expect.objectContaining({
            actorId: assigneeId,
            incidentId,
            action: 'TASK_COMPLETED_BY_ASSIGNEE',
            metadata: expect.objectContaining({
              taskId,
              previousStatus: 'IN_PROGRESS',
              newStatus: 'COMPLETED_BY_ASSIGNEE'
            })
          }),
          expect.objectContaining({
            action: 'REPORTER_VERIFICATION_REQUESTED',
            incidentId
          })
        ])
      });
    });
  });

  it('H. Reporter Press 1 closes the incident and records confirmation', async () => {
    const now = new Date('2026-10-03T10:05:00.000Z');
    const verification = {
      id: verificationId,
      incidentId,
      reporterId,
      status: 'PENDING',
      language: 'hi',
      prompt: 'Machine 4 की समस्या ठीक बताई गई है।',
      incident: {
        id: incidentId,
        reporterId,
        status: 'REPORTER_VERIFICATION_PENDING',
        incidentNumber: 'INC-123',
        tasks: [{ id: taskId, assignee: { id: assigneeId, email: 'tech@example.test' } }]
      }
    };

    const incidentUpdateManySpy = vi.fn().mockResolvedValue({ count: 1 });
    const verificationUpdateManySpy = vi.fn().mockResolvedValue({ count: 1 });
    const auditCreateManySpy = vi.fn().mockResolvedValue({ count: 2 });
    const auditCreateSpy = vi.fn().mockResolvedValue({});

    const tx = {
      closureVerification: {
        updateMany: verificationUpdateManySpy,
        findUnique: vi.fn().mockResolvedValue({ ...verification, status: 'CONFIRMED' })
      },
      incident: {
        updateMany: incidentUpdateManySpy
      },
      voiceReport: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 })
      },
      task: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 })
      },
      auditLog: {
        createMany: auditCreateManySpy,
        create: auditCreateSpy
      }
    };

    const database = {
      closureVerification: {
        findUnique: vi.fn().mockResolvedValue(verification)
      },
      auditLog: {
        create: auditCreateSpy
      },
      $transaction: vi.fn((callback: (txArg: typeof tx) => unknown) => callback(tx))
    } as unknown as DatabaseClient;

    await withApi(database, async (url) => {
      const response = await fetch(`${url}/api/incidents/${incidentId}/verify-closure`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${tokenFor(reporterId, 'EMPLOYEE')}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ verificationId, response: '1' })
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.status).toBe('CLOSED');

      // Verify incident transitioned to CLOSED
      expect(incidentUpdateManySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'CLOSED' })
        })
      );

      // Verify confirmation recorded
      expect(verificationUpdateManySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: verificationId, reporterId, status: 'PENDING' }),
          data: expect.objectContaining({ status: 'CONFIRMED', response: '1' })
        })
      );
    });
  });

  it('I. Reporter Press 2 reopens the incident and returns task to OPEN', async () => {
    const verification = {
      id: verificationId,
      incidentId,
      reporterId,
      status: 'PENDING',
      language: 'hi',
      prompt: 'Machine 4 की समस्या ठीक बताई गई है।',
      incident: {
        id: incidentId,
        reporterId,
        status: 'REPORTER_VERIFICATION_PENDING',
        incidentNumber: 'INC-123',
        tasks: [{ id: taskId, assignee: { id: assigneeId, email: 'tech@example.test' } }]
      }
    };

    const incidentUpdateManySpy = vi.fn().mockResolvedValue({ count: 1 });
    const taskUpdateManySpy = vi.fn().mockResolvedValue({ count: 1 });
    const verificationUpdateManySpy = vi.fn().mockResolvedValue({ count: 1 });

    const tx = {
      closureVerification: {
        updateMany: verificationUpdateManySpy,
        findUnique: vi.fn().mockResolvedValue({ ...verification, status: 'REJECTED' })
      },
      incident: {
        updateMany: incidentUpdateManySpy
      },
      voiceReport: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 })
      },
      task: {
        updateMany: taskUpdateManySpy
      },
      auditLog: {
        createMany: vi.fn().mockResolvedValue({ count: 3 }),
        create: vi.fn().mockResolvedValue({})
      }
    };

    const database = {
      closureVerification: {
        findUnique: vi.fn().mockResolvedValue(verification)
      },
      notification: {
        create: vi.fn().mockResolvedValue({ id: 'notice-1', status: 'SENT' })
      },
      auditLog: {
        create: vi.fn().mockResolvedValue({})
      },
      $transaction: vi.fn((callback: (txArg: typeof tx) => unknown) => callback(tx))
    } as unknown as DatabaseClient;

    await withApi(database, async (url) => {
      const response = await fetch(`${url}/api/incidents/${incidentId}/verify-closure`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${tokenFor(reporterId, 'EMPLOYEE')}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ verificationId, response: '2' })
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.status).toBe('REOPENED');

      // Verify incident transitioned to REOPENED
      expect(incidentUpdateManySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'REOPENED' })
        })
      );

      // Verify task returned to OPEN
      expect(taskUpdateManySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ incidentId, status: 'COMPLETED_BY_ASSIGNEE' }),
          data: expect.objectContaining({ status: 'OPEN' })
        })
      );
    });
  });

  it('J. Completing an already completed task is rejected with 409 Conflict', async () => {
    const completedTask = {
      id: taskId,
      incidentId,
      assigneeId,
      status: 'COMPLETED_BY_ASSIGNEE',
      assignee: { id: assigneeId, managerId: null },
      incident: { id: incidentId, reporterId, status: 'REPORTER_VERIFICATION_PENDING', voiceReports: [] }
    };

    const database = {
      task: {
        findUnique: vi.fn().mockResolvedValue(completedTask)
      }
    } as unknown as DatabaseClient;

    await withApi(database, async (url) => {
      const response = await fetch(`${url}/api/tasks/${taskId}/complete`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${tokenFor(assigneeId, 'EMPLOYEE')}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({})
      });

      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.error).toContain('Cannot complete a task in COMPLETED_BY_ASSIGNEE');
    });
  });

  it('K. Unauthorized users cannot complete another persons task', async () => {
    const task = {
      id: taskId,
      incidentId,
      assigneeId: 'other-employee',
      status: 'IN_PROGRESS',
      assignee: { id: 'other-employee', managerId: 'manager-1' },
      incident: { id: incidentId, reporterId: 'reporter-1' }
    };

    const database = {
      task: {
        findUnique: vi.fn().mockResolvedValue(task)
      }
    } as unknown as DatabaseClient;

    await withApi(database, async (url) => {
      // 1. Unrelated employee
      const employeeRes = await fetch(`${url}/api/tasks/${taskId}/complete`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${tokenFor('random-employee', 'EMPLOYEE')}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({})
      });
      expect(employeeRes.status).toBe(403);
      expect((await employeeRes.json()).error).toContain('Only the assignee or a manager can complete this task');

      // 2. Manager outside reporting line
      const managerRes = await fetch(`${url}/api/tasks/${taskId}/complete`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${tokenFor('other-manager', 'MANAGER')}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({})
      });
      expect(managerRes.status).toBe(403);
      expect((await managerRes.json()).error).toContain('You cannot access this task');
    });
  });
});
