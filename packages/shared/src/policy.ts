export type Phase = 'open' | 'grace' | 'closed';

export const PART_SIZE = 8 * 1024 * 1024;
export const MAX_SIGN_EXPIRY_S = 15 * 60;

/** Pure policy helpers so boundary tests need no DB (PRD §5). */
export function phaseAt(now: Date, deadline: Date, graceSeconds: number): Phase {
  if (now < deadline) return 'open';
  if (now < new Date(deadline.getTime() + graceSeconds * 1000)) return 'grace';
  return 'closed';
}
export const canStart = (now: Date, deadline: Date) => now < deadline;
export const canEditMetadata = canStart;
export const canComplete = (now: Date, deadline: Date, graceSeconds: number) =>
  now < new Date(deadline.getTime() + graceSeconds * 1000);

/** Signed URL expiry = min(15min, deadline+grace-now); <=0 means none allowed. */
export function signExpirySeconds(now: Date, deadline: Date, graceSeconds: number): number {
  const left = Math.floor((deadline.getTime() + graceSeconds * 1000 - now.getTime()) / 1000);
  return Math.min(MAX_SIGN_EXPIRY_S, left);
}
export const totalParts = (size: number) => Math.max(1, Math.ceil(size / PART_SIZE));
