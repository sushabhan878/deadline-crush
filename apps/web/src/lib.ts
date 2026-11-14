/** Pure UI helpers (no DOM, no fetch) so they can be unit tested. */

export type Phase = 'open' | 'grace' | 'closed';

export function phaseAt(nowMs: number, deadlineMs: number, graceEndsMs: number): Phase {
  if (nowMs < deadlineMs) return 'open';
  if (nowMs < graceEndsMs) return 'grace';
  return 'closed';
}

/** Split a duration into countdown boxes. Negative durations clamp to zero. */
export function splitDuration(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return { days: Math.floor(s / 86400), hours: Math.floor((s % 86400) / 3600), mins: Math.floor((s % 3600) / 60), secs: s % 60 };
}

export const pad2 = (n: number) => String(n).padStart(2, '0');

export function formatBytes(n?: number | string | null): string {
  if (n == null || n === '') return '—';
  let v = Number(n);
  if (!Number.isFinite(v) || v < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${i === 0 ? v : v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

export function formatDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '—';
  const s = Math.round(sec);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export const shortDate = (d: string | number | Date) =>
  new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

export const fileExt = (name: string) => (name.includes('.') ? name.split('.').pop()!.toLowerCase() : '');

/** Client-side pre-check; the server re-validates everything. */
export function validateFile(f: { name: string; size: number }, maxBytes: number, allowed: string[]): string | null {
  if (f.size <= 0) return 'The file is empty.';
  if (!allowed.includes(fileExt(f.name))) return `Only ${allowed.map((a) => `.${a}`).join(', ')} files are accepted.`;
  if (f.size > maxBytes) return `File is ${formatBytes(f.size)}; the limit is ${formatBytes(maxBytes)}.`;
  return null;
}

export const parseLinks = (text: string) => text.split('\n').map((s) => s.trim()).filter(Boolean);

/** Mirrors packages/shared metadataSchema so users see errors before saving. */
export function validateMetadata(m: { title: string; description: string; links: string }, maxLinks: number) {
  const errors: Record<string, string> = {};
  const title = m.title.trim();
  if (title.length < 3) errors.title = 'Title must be at least 3 characters.';
  else if (title.length > 120) errors.title = 'Title must be at most 120 characters.';
  if (m.description.length > 5000) errors.description = 'Description must be at most 5000 characters.';
  const links = parseLinks(m.links);
  if (links.length > maxLinks) errors.links = `At most ${maxLinks} links.`;
  else {
    const bad = links.find((l) => { try { return new URL(l).protocol !== 'https:'; } catch { return true; } });
    if (bad) errors.links = `Not a valid https link: ${bad}`;
  }
  return errors;
}

export type VersionStatus = 'uploading' | 'uploaded' | 'checking' | 'accepted' | 'needs_fix' | 'aborted' | 'expired';

export const STATUS_META: Record<string, { label: string; tone: 'ok' | 'warn' | 'bad' | 'info' | 'muted'; icon: string }> = {
  uploading: { label: 'Uploading', tone: 'info', icon: '↑' },
  uploaded: { label: 'Uploaded', tone: 'info', icon: '✓' },
  checking: { label: 'Checking', tone: 'warn', icon: '⟳' },
  accepted: { label: 'Accepted', tone: 'ok', icon: '✓' },
  needs_fix: { label: 'Needs fix', tone: 'bad', icon: '!' },
  aborted: { label: 'Aborted', tone: 'muted', icon: '×' },
  expired: { label: 'Expired', tone: 'muted', icon: '⌛' },
  none: { label: 'No submission', tone: 'muted', icon: '–' },
};
export const statusMeta = (s?: string | null) => STATUS_META[s ?? 'none'] ?? { label: s ?? '—', tone: 'muted' as const, icon: '•' };

/** Timeline steps for the latest version; index of the active step. */
export function timeline(status: string): { steps: string[]; active: number; failed: boolean } {
  const last = status === 'needs_fix' ? 'needs_fix' : 'accepted';
  const steps = ['uploading', 'uploaded', 'checking', last];
  const order: Record<string, number> = { uploading: 0, uploaded: 1, checking: 2, accepted: 3, needs_fix: 3 };
  return { steps, active: order[status] ?? -1, failed: status === 'needs_fix' };
}

const HINTS: Record<string, string> = {
  type: 'Upload a real PDF or ZIP. Renamed executables or other formats are rejected.',
  archive: 'Re-zip the project without encryption, absolute paths, or "../" entries, and keep it under the size limits.',
  links: 'Make sure every link is public, uses https, and returns a 2xx/3xx response.',
  preview: 'We could not render a preview. Add a README to your ZIP or check that the PDF opens.',
  hash: 'The file could not be read back from storage. Upload it again.',
};
export const fixHint = (check: string) => HINTS[check] ?? 'Fix the issue and upload a new version.';

export const CHECK_LABEL: Record<string, string> = {
  type: 'File type', archive: 'Archive safety', links: 'Links reachable', preview: 'Preview', hash: 'SHA-256 hash',
};

/** Upload speed/ETA from progress samples taken over time. */
export function rate(samples: { t: number; bytes: number }[], total: number) {
  if (samples.length < 2) return { bps: 0, etaSec: NaN };
  const a = samples[0], b = samples[samples.length - 1];
  const dt = (b.t - a.t) / 1000;
  const bps = dt > 0 ? (b.bytes - a.bytes) / dt : 0;
  return { bps, etaSec: bps > 0 ? (total - b.bytes) / bps : NaN };
}

export const initials = (s: string) =>
  s.split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?';
