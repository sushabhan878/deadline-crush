export type ErrorCode =
  | 'DEADLINE_PASSED' | 'GRACE_EXPIRED' | 'NOT_A_MEMBER' | 'INVALID_PARTS'
  | 'SIZE_MISMATCH' | 'RATE_LIMITED' | 'VERSION_STATE_CONFLICT' | 'UNAUTHORIZED'
  | 'FORBIDDEN' | 'NOT_FOUND' | 'VALIDATION' | 'INTERNAL';

export const ERROR_STATUS: Record<ErrorCode, number> = {
  DEADLINE_PASSED: 403, GRACE_EXPIRED: 409, NOT_A_MEMBER: 403, INVALID_PARTS: 400,
  SIZE_MISMATCH: 409, RATE_LIMITED: 429, VERSION_STATE_CONFLICT: 409, UNAUTHORIZED: 401,
  FORBIDDEN: 403, NOT_FOUND: 404, VALIDATION: 400, INTERNAL: 500,
};

export class AppError extends Error {
  constructor(public code: ErrorCode, message?: string, public details?: unknown) {
    super(message ?? code);
  }
  get status() { return ERROR_STATUS[this.code]; }
}
