import { createDatabase } from '../apps/api/src/db.js';
import { hashPassword } from '../apps/api/src/auth.js';

const database = createDatabase();
if (!database) throw new Error('DATABASE_URL is required to seed VoiceBridge.');
const db = database;

async function seed() {
const departmentNames = ['Maintenance', 'IT', 'Security', 'Operations', 'HR', 'Facilities'];
const departments = new Map<string, string>();
for (const name of departmentNames) {
  const department = await db.department.upsert({ where: { name }, update: {}, create: { name, description: `${name} incident response team` } });
  departments.set(name, department.id);
}

const passwordHash = await hashPassword(process.env.DEMO_PASSWORD ?? 'VoiceBridgeDemo2026!');
const admin = await db.employee.upsert({
  where: { email: 'admin@voicebridge.local' },
  update: { passwordHash, role: 'ADMIN', isActive: true },
  create: { name: 'Avery Admin', email: 'admin@voicebridge.local', passwordHash, role: 'ADMIN', jobTitle: 'Operations Administrator' }
});

const managers = new Map<string, string>();
for (const name of departmentNames) {
  const slug = name.toLowerCase().replaceAll(' ', '.');
  const manager = await db.employee.upsert({
    where: { email: `${slug}.manager@voicebridge.local` },
    update: { departmentId: departments.get(name), managerId: admin.id, passwordHash, role: 'MANAGER', isActive: true },
    create: { name: `${name} Lead`, email: `${slug}.manager@voicebridge.local`, passwordHash, role: 'MANAGER', jobTitle: `${name} Manager`, departmentId: departments.get(name), managerId: admin.id }
  });
  managers.set(name, manager.id);
}

const employeeSeeds = [
  ['Sam Reporter', 'employee@voicebridge.local', 'Maintenance'], ['Priya Nair', 'priya@voicebridge.local', 'Maintenance'],
  ['Jamie Chen', 'jamie@voicebridge.local', 'IT'], ['Noor Ali', 'noor@voicebridge.local', 'IT'],
  ['Morgan Reed', 'morgan@voicebridge.local', 'Facilities'], ['Taylor Singh', 'taylor@voicebridge.local', 'Facilities'],
  ['Alex Rivera', 'alex@voicebridge.local', 'Security'], ['Casey Patel', 'casey@voicebridge.local', 'Security'],
  ['Robin Das', 'robin@voicebridge.local', 'Operations'], ['Drew Shah', 'drew@voicebridge.local', 'Operations'],
  ['Jordan Kim', 'jordan@voicebridge.local', 'HR'], ['Riley Bose', 'riley@voicebridge.local', 'HR']
] as const;
const employees = new Map<string, string>();
for (const [name, email, department] of employeeSeeds) {
  const employee = await db.employee.upsert({
    where: { email },
    update: { passwordHash, role: 'EMPLOYEE', isActive: true, departmentId: departments.get(department), managerId: managers.get(department) },
    create: { name, email, passwordHash, role: 'EMPLOYEE', jobTitle: 'Team Member', departmentId: departments.get(department), managerId: managers.get(department) }
  });
  employees.set(email, employee.id);
}

await db.escalationRule.deleteMany({});
await db.escalationRule.createMany({ data: departmentNames.map((name) => ({ departmentId: departments.get(name), reminderBeforeMinutes: 60, escalateAfterMinutes: 0, enabled: true })) });

const existing = await db.incident.findMany({ where: { incidentNumber: { startsWith: 'INC-DEMO-' } }, select: { id: true } });
const existingIds = existing.map((incident) => incident.id);
if (existingIds.length) {
  await db.$transaction([
    db.notification.deleteMany({ where: { incidentId: { in: existingIds } } }),
    db.auditLog.deleteMany({ where: { incidentId: { in: existingIds } } }),
    db.incident.deleteMany({ where: { id: { in: existingIds } } })
  ]);
}

const scenarios = [
  { issue: 'Machine 4 is making a strange noise', asset: 'Machine 4', place: 'Packaging Line', department: 'Maintenance', priority: 'HIGH' as const, status: 'OPEN' as const, reporter: 'employee@voicebridge.local', assignee: 'priya@voicebridge.local' },
  { issue: 'Water leakage near second floor washroom', asset: null, place: 'Second Floor Washroom', department: 'Facilities', priority: 'MEDIUM' as const, status: 'IN_PROGRESS' as const, reporter: 'employee@voicebridge.local', assignee: 'morgan@voicebridge.local' },
  { issue: 'Exposed electrical wiring near server room', asset: 'Electrical panel', place: 'Server Room', department: 'Facilities', priority: 'CRITICAL' as const, status: 'ESCALATED' as const, reporter: 'jamie@voicebridge.local', assignee: 'morgan@voicebridge.local' },
  { issue: 'Printer is offline in the west office', asset: 'Printer 2', place: 'West Office', department: 'IT', priority: 'LOW' as const, status: 'COMPLETED' as const, reporter: 'noor@voicebridge.local', assignee: 'jamie@voicebridge.local' },
  { issue: 'Loading bay door sensor is intermittent', asset: 'Bay Door 2', place: 'Loading Bay', department: 'Facilities', priority: 'MEDIUM' as const, status: 'OPEN' as const, reporter: 'robin@voicebridge.local', assignee: 'taylor@voicebridge.local' },
  { issue: 'Conveyor belt stopped on line 3', asset: 'Conveyor 3', place: 'Assembly Line', department: 'Maintenance', priority: 'HIGH' as const, status: 'OVERDUE' as const, reporter: 'priya@voicebridge.local', assignee: 'employee@voicebridge.local' },
  { issue: 'Access badge reader not responding', asset: 'Badge Reader', place: 'North Entrance', department: 'Security', priority: 'MEDIUM' as const, status: 'IN_PROGRESS' as const, reporter: 'casey@voicebridge.local', assignee: 'alex@voicebridge.local' },
  { issue: 'Spill reported beside the cafeteria', asset: null, place: 'Cafeteria', department: 'Facilities', priority: 'HIGH' as const, status: 'COMPLETED' as const, reporter: 'drew@voicebridge.local', assignee: 'morgan@voicebridge.local' },
  { issue: 'Network drops in training room', asset: 'Network switch', place: 'Training Room', department: 'IT', priority: 'HIGH' as const, status: 'OPEN' as const, reporter: 'jordan@voicebridge.local', assignee: 'noor@voicebridge.local' },
  { issue: 'Forklift inspection overdue', asset: 'Forklift 12', place: 'Warehouse', department: 'Operations', priority: 'CRITICAL' as const, status: 'ESCALATED' as const, reporter: 'riley@voicebridge.local', assignee: 'robin@voicebridge.local' }
];

const now = new Date();
for (let index = 0; index < scenarios.length; index += 1) {
  const scenario = scenarios[index]!;
  const due = new Date(now.getTime() + (scenario.status === 'COMPLETED' ? -48 : ['OVERDUE', 'ESCALATED'].includes(scenario.status) ? -2 : 1 + index) * 60 * 60_000);
  const reporterId = employees.get(scenario.reporter)!;
  const assigneeId = employees.get(scenario.assignee)!;
  const incident = await db.incident.create({ data: {
    incidentNumber: `INC-DEMO-2026-${String(index + 1).padStart(3, '0')}`,
    title: scenario.issue,
    description: `${scenario.issue} at ${scenario.place}. Please investigate and report the outcome.`,
    abnormality: scenario.issue,
    asset: scenario.asset,
    location: scenario.place,
    requestedAction: `Investigate ${scenario.issue.toLowerCase()}`,
    responsibleDepartment: scenario.department,
    responsiblePerson: employeeSeeds.find((entry) => employees.get(entry[1]) === assigneeId)?.[0] ?? 'Assigned team member',
    priority: scenario.priority,
    status: scenario.status === 'COMPLETED' ? 'REPORTER_VERIFICATION_PENDING' : scenario.status,
    reporterVerificationStatus: scenario.status === 'COMPLETED' ? 'PENDING' : null,
    confidence: 0.92,
    extractedData: { source: 'seed', confidence: 0.92 },
    deadline: due,
    reporterId
  } });
  const task = await db.task.create({ data: {
    title: incident.requestedAction ?? scenario.issue,
    description: incident.description,
    status: scenario.status,
    deadline: due,
    incidentId: incident.id,
    assigneeId,
    createdById: reporterId,
    completedAt: scenario.status === 'COMPLETED' ? new Date(due.getTime() + 30 * 60_000) : null
  } });
  await db.assignment.create({ data: { taskId: task.id, employeeId: assigneeId, assignedById: reporterId, reason: `Seeded ${scenario.department} responsibility mapping`, confidence: 0.92 } });
  if (scenario.status === 'COMPLETED') await db.closureVerification.create({ data: { incidentId: incident.id, reporterId, attemptNumber: 1 } });
  await db.reminder.create({ data: { taskId: task.id, scheduledAt: new Date(Math.max(now.getTime(), due.getTime() - 60 * 60_000)), status: scenario.status === 'COMPLETED' ? 'FAILED' : 'PENDING' } });
  if (scenario.status === 'ESCALATED') {
    await db.escalation.create({ data: { taskId: task.id, managerId: managers.get(scenario.department)!, reason: 'Seeded overdue escalation.', level: 1 } });
  }
  await db.auditLog.create({ data: { actorId: reporterId, incidentId: incident.id, action: 'INCIDENT_CREATED', reason: 'Realistic demonstration data.', metadata: { scenario: index + 1 } } });
}

console.info('Seeded 6 departments, 19 employees, 10 incidents, and 10 tasks.');
console.info('Demo accounts: admin@voicebridge.local, maintenance.manager@voicebridge.local, employee@voicebridge.local');
console.info(`Demo password: ${process.env.DEMO_PASSWORD ?? 'VoiceBridgeDemo2026!'}`);
}

void seed().then(() => db.$disconnect()).catch(async (error: unknown) => {
  console.error(error);
  await db.$disconnect();
  process.exitCode = 1;
});
