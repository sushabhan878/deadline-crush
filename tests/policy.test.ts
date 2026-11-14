import { describe, expect, it } from 'vitest';
import { FakeClock, canComplete, canEditMetadata, canStart, phaseAt, signExpirySeconds, totalParts } from '@dc/shared';

const D = new Date('2026-01-01T12:00:00Z');
const at = (s: number) => new Date(D.getTime() + s * 1000);

describe('deadline policy', () => {
  it('start at T-1s ok', () => expect(canStart(at(-1), D)).toBe(true));
  it('start at T+1s rejected', () => expect(canStart(at(1), D)).toBe(false));
  it('start exactly at T rejected', () => expect(canStart(at(0), D)).toBe(false));
  it('complete at T+grace-1s ok', () => expect(canComplete(at(299), D, 300)).toBe(true));
  it('complete at T+grace+1s rejected', () => expect(canComplete(at(301), D, 300)).toBe(false));
  it('metadata edit at T+1s rejected', () => expect(canEditMetadata(at(1), D)).toBe(false));
  it('grace=0 closes completion at deadline', () => expect(canComplete(at(0), D, 0)).toBe(false));
  it('phases', () => {
    expect(phaseAt(at(-5), D, 300)).toBe('open');
    expect(phaseAt(at(5), D, 300)).toBe('grace');
    expect(phaseAt(at(301), D, 300)).toBe('closed');
  });
  it('signed url expiry capped by cutoff', () => {
    expect(signExpirySeconds(at(-3600), D, 300)).toBe(900);
    expect(signExpirySeconds(at(250), D, 300)).toBe(50);
    expect(signExpirySeconds(at(300), D, 300)).toBeLessThanOrEqual(0);
  });
  it('part count', () => { expect(totalParts(1)).toBe(1); expect(totalParts(100 * 1024 * 1024)).toBe(13); });
  it('FakeClock is settable', async () => {
    const c = new FakeClock(D); c.advance(1000);
    expect((await c.now()).getTime()).toBe(D.getTime() + 1000);
  });
});
