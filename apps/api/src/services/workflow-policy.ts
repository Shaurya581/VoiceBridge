import type { Priority } from '../generated/prisma/enums.js';

export function isValidDeadline(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

export interface EscalationPolicyCandidate {
  department: { name: string } | null;
  priority: Priority | null;
  reminderBeforeMinutes: number;
  escalateAfterMinutes: number;
  enabled?: boolean;
}

export function selectEscalationPolicy<T extends EscalationPolicyCandidate>(
  policies: T[], departmentName: string | null | undefined, priority: Priority
) {
  const normalizedDepartment = departmentName?.trim().toLocaleLowerCase() ?? '';
  return policies
    .filter((policy) => policy.enabled !== false)
    .filter((policy) => !policy.department || policy.department.name.trim().toLocaleLowerCase() === normalizedDepartment)
    .filter((policy) => !policy.priority || policy.priority === priority)
    .sort((left, right) => {
      const leftDepartmentSpecific = left.department ? 1 : 0;
      const rightDepartmentSpecific = right.department ? 1 : 0;
      if (leftDepartmentSpecific !== rightDepartmentSpecific) return rightDepartmentSpecific - leftDepartmentSpecific;
      const leftPrioritySpecific = left.priority ? 1 : 0;
      const rightPrioritySpecific = right.priority ? 1 : 0;
      return rightPrioritySpecific - leftPrioritySpecific;
    })[0];
}
