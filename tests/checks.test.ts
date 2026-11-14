import { describe, expect, it } from 'vitest';
import zlib from 'node:zlib';
import { isBlockedIp } from '../apps/worker/src/ssrf';
import { analyzeEntries, inflateLimited, type ZipEntry } from '../apps/worker/src/zip';
import { detectType } from '../apps/worker/src/checks';

const entry = (o: Partial<ZipEntry>): ZipEntry => ({ name: 'a.txt', method: 8, flags: 0, csize: 100, usize: 200, offset: 0, mode: 0, ...o });

describe('SSRF guard', () => {
  it.each(['127.0.0.1', '10.1.2.3', '169.254.169.254', '192.168.1.1', '172.16.0.1', '100.64.0.1', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1'])('blocks %s', (ip) =>
    expect(isBlockedIp(ip)).toBe(true));
  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])('allows %s', (ip) => expect(isBlockedIp(ip)).toBe(false));
});

describe('type by content', () => {
  it('pdf', () => expect(detectType(Buffer.from('%PDF-1.7'))).toBe('pdf'));
  it('zip', () => expect(detectType(Buffer.from([0x50, 0x4b, 3, 4]))).toBe('zip'));
  it('exe renamed .pdf rejected', () => expect(detectType(Buffer.from('MZ\x90\x00'))).toBeNull());
});

describe('archive safety', () => {
  it('zip-slip', () => expect(analyzeEntries([entry({ name: '../../etc/passwd' })], 1000).join()).toContain('PATH_TRAVERSAL'));
  it('absolute + drive paths', () => {
    expect(analyzeEntries([entry({ name: '/etc/x' })], 1000).join()).toContain('PATH_TRAVERSAL');
    expect(analyzeEntries([entry({ name: 'C:\\x'})], 1000).join()).toContain('PATH_TRAVERSAL');
  });
  it('encrypted', () => expect(analyzeEntries([entry({ flags: 1 })], 1000).join()).toContain('ENCRYPTED'));
  it('bomb ratio', () => expect(analyzeEntries([entry({ csize: 10, usize: 10_000_000 })], 1000).join()).toContain('RATIO'));
  it('symlink', () => expect(analyzeEntries([entry({ mode: 0o120777 })], 1000).join()).toContain('SYMLINK'));
  it('nested archive', () => expect(analyzeEntries([entry({ name: 'x.zip' })], 1000).join()).toContain('NESTED'));
  it('clean zip', () => expect(analyzeEntries([entry({})], 1000)).toEqual([]));
  it('lying header: counter aborts when output exceeds declared size', () => {
    const big = zlib.deflateRawSync(Buffer.alloc(5_000_000));
    expect(() => inflateLimited(big, 8, 1000)).toThrow();
  });
  it('honest data inflates', () => {
    const d = zlib.deflateRawSync(Buffer.from('hello'));
    expect(inflateLimited(d, 8, 100).toString()).toBe('hello');
  });
});
