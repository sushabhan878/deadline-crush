import { describe, expect, it } from 'vitest';
import {
  formatBytes, formatDuration, initials, phaseAt, rate, splitDuration, statusMeta, timeline, validateFile, validateMetadata,
} from '../apps/web/src/lib';

describe('web countdown helpers', () => {
  it('splits durations into days/hours/mins/secs', () => {
    expect(splitDuration(((1 * 24 + 13) * 3600 + 31 * 60 + 57) * 1000 + 400)).toEqual({ days: 1, hours: 13, mins: 31, secs: 57 });
    expect(splitDuration(-5000)).toEqual({ days: 0, hours: 0, mins: 0, secs: 0 });
  });
  it('derives phase at exact boundaries', () => {
    expect(phaseAt(999, 1000, 2000)).toBe('open');
    expect(phaseAt(1000, 1000, 2000)).toBe('grace');
    expect(phaseAt(2000, 1000, 2000)).toBe('closed');
    expect(phaseAt(1000, 1000, 1000)).toBe('closed'); // grace = 0
  });
});

describe('formatting', () => {
  it('formats bytes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(100 * 1024 * 1024)).toBe('100 MB');
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes('2048')).toBe('2.0 KB');
  });
  it('formats durations', () => {
    expect(formatDuration(42)).toBe('42s');
    expect(formatDuration(125)).toBe('2m 5s');
    expect(formatDuration(NaN)).toBe('—');
  });
  it('builds initials', () => {
    expect(initials('team1@demo.test')).toBe('TD');
    expect(initials('Sushant Mehta')).toBe('SM');
  });
});

describe('client-side validation', () => {
  const MB = 1024 * 1024;
  it('validates files', () => {
    expect(validateFile({ name: 'a.pdf', size: 10 }, 100 * MB, ['pdf', 'zip'])).toBeNull();
    expect(validateFile({ name: 'a.PDF', size: 10 }, 100 * MB, ['pdf', 'zip'])).toBeNull();
    expect(validateFile({ name: 'a.exe', size: 10 }, 100 * MB, ['pdf', 'zip'])).toMatch(/Only/);
    expect(validateFile({ name: 'a.zip', size: 101 * MB }, 100 * MB, ['pdf', 'zip'])).toMatch(/limit/);
    expect(validateFile({ name: 'a.zip', size: 0 }, 100 * MB, ['pdf', 'zip'])).toMatch(/empty/);
  });
  it('validates metadata like the server schema', () => {
    expect(validateMetadata({ title: 'My project', description: '', links: 'https://a.dev\n\nhttps://b.dev' }, 5)).toEqual({});
    expect(validateMetadata({ title: 'ab', description: '', links: '' }, 5).title).toBeTruthy();
    expect(validateMetadata({ title: 'abc', description: '', links: 'http://insecure.dev' }, 5).links).toMatch(/https/);
    expect(validateMetadata({ title: 'abc', description: '', links: 'https://a\nhttps://b\nhttps://c' }, 2).links).toMatch(/At most 2/);
  });
});

describe('status helpers', () => {
  it('maps statuses with non-colour labels', () => {
    expect(statusMeta('needs_fix').label).toBe('Needs fix');
    expect(statusMeta(null).label).toBe('No submission');
  });
  it('computes timeline', () => {
    expect(timeline('checking')).toEqual({ steps: ['uploading', 'uploaded', 'checking', 'accepted'], active: 2, failed: false });
    expect(timeline('needs_fix').steps[3]).toBe('needs_fix');
    expect(timeline('needs_fix').failed).toBe(true);
  });
  it('computes upload rate and eta', () => {
    const r = rate([{ t: 0, bytes: 0 }, { t: 2000, bytes: 2000 }], 10_000);
    expect(r.bps).toBe(1000);
    expect(r.etaSec).toBe(8);
    expect(Number.isNaN(rate([], 10).etaSec)).toBe(true);
  });
});
