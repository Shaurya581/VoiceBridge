import type { DatabaseClient } from '../db.js';

export type Resolution =
  | { employeeId: string; department: string; reason: string; confidence: number }
  | { employeeId: null; department: string | null; reason: string; confidence: number; options: Array<{ id: string; name: string; email: string; role: string }> };

export async function resolveResponsibility(db: DatabaseClient, departmentName: string | null, namedPerson: string | null): Promise<Resolution> {
  if (namedPerson) {
    const matches = await db.employee.findMany({
      where: { isActive: true, OR: [{ name: { contains: namedPerson, mode: 'insensitive' } }, { email: { equals: namedPerson, mode: 'insensitive' } }] },
      include: { department: true }, take: 6
    });
    if (matches.length === 1) return { employeeId: matches[0]!.id, department: matches[0]!.department?.name ?? departmentName ?? 'Unassigned', reason: `The report names ${matches[0]!.name}.`, confidence: 0.98 };
    return { employeeId: null, department: departmentName, reason: matches.length ? 'More than one directory entry matches the named person.' : 'The named person was not found in the employee directory.', confidence: matches.length ? 0.4 : 0.2, options: matches.map(({ id, name, email, role }) => ({ id, name, email, role })) };
  }
  if (!departmentName) return { employeeId: null, department: null, reason: 'The report does not identify a responsible department.', confidence: 0, options: [] };

  const department = await db.department.findFirst({
    where: { name: { equals: departmentName, mode: 'insensitive' } },
    include: { employees: { where: { isActive: true }, orderBy: { name: 'asc' } } }
  });
  if (!department) return { employeeId: null, department: departmentName, reason: 'The department is not configured in the directory.', confidence: 0.2, options: [] };
  const managers = department.employees.filter((employee) => employee.role === 'MANAGER' || employee.role === 'ADMIN');
  const candidates = managers.length ? managers : department.employees;
  if (candidates.length === 1) return {
    employeeId: candidates[0]!.id,
    department: department.name,
    reason: managers.length ? `Assigned to the configured ${department.name} team lead.` : `Only one active employee is configured in ${department.name}.`,
    confidence: managers.length ? 0.9 : 0.72
  };
  return {
    employeeId: null,
    department: department.name,
    reason: candidates.length ? `Several people could handle this ${department.name} issue; choose an owner.` : `No active employee is configured in ${department.name}.`,
    confidence: 0.35,
    options: candidates.map(({ id, name, email, role }) => ({ id, name, email, role }))
  };
}

