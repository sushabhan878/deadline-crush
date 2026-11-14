import zlib from 'node:zlib';

export interface ZipLimits {
  maxEntries: number; maxTotal: number; maxEntry: number; maxRatio: number; maxEntryRatio: number;
}
export const DEFAULT_LIMITS: ZipLimits = {
  maxEntries: 10_000, maxTotal: 1024 ** 3, maxEntry: 500 * 1024 ** 2, maxRatio: 100, maxEntryRatio: 200,
};
export interface ZipEntry {
  name: string; method: number; flags: number; csize: number; usize: number; offset: number; mode: number;
}
export type RangeReader = (start: number, endInclusive: number) => Promise<Buffer>;

/** Parse the central directory using only ranged reads of the tail (no full download). */
export async function readCentralDirectory(size: number, read: RangeReader): Promise<ZipEntry[]> {
  const tailLen = Math.min(size, 65_557);
  const tail = await read(size - tailLen, size - 1);
  let e = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) { e = i; break; }
  }
  if (e < 0) throw new Error('EOCD not found');
  const total = tail.readUInt16LE(e + 10);
  const cdSize = tail.readUInt32LE(e + 12);
  const cdOff = tail.readUInt32LE(e + 16);
  if (total === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) throw new Error('zip64 not supported');
  if (tail.readUInt16LE(e + 4) || tail.readUInt16LE(e + 6) || tail.readUInt16LE(e + 8) !== total) throw new Error('multiple ZIP disks are unsupported');
  if (cdOff + cdSize > size - tailLen + e) throw new Error('central directory out of bounds');
  if (!total || total > DEFAULT_LIMITS.maxEntries) throw new Error('archive entry count outside accepted range');
  if (cdSize > 32 * 1024 * 1024) throw new Error('central directory too large');
  const cd = await read(cdOff, cdOff + cdSize - 1);
  const out: ZipEntry[] = [];
  let p = 0;
  for (let i = 0; i < total; i++) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt central directory');
    const nameLen = cd.readUInt16LE(p + 28), extraLen = cd.readUInt16LE(p + 30), cmtLen = cd.readUInt16LE(p + 32);
    if (p + 46 + nameLen + extraLen + cmtLen > cd.length) throw new Error('truncated central directory entry');
    out.push({
      flags: cd.readUInt16LE(p + 8), method: cd.readUInt16LE(p + 10), csize: cd.readUInt32LE(p + 20),
      usize: cd.readUInt32LE(p + 24), mode: cd.readUInt32LE(p + 38) >>> 16, offset: cd.readUInt32LE(p + 42),
      name: cd.subarray(p + 46, p + 46 + nameLen).toString('utf8'),
    });
    p += 46 + nameLen + extraLen + cmtLen;
  }
  if (p !== cd.length) throw new Error('unexpected central directory data');
  return out;
}

const NESTED = /\.(zip|jar|7z|rar|tar|gz|tgz|bz2|xz)$/i;

/** Returns a list of human-readable problems (empty = safe). Pure; unit-testable. */
export function analyzeEntries(entries: ZipEntry[], fileSize: number, L: ZipLimits = DEFAULT_LIMITS): string[] {
  const bad: string[] = [];
  if (entries.length > L.maxEntries) bad.push(`ARCHIVE_TOO_MANY_ENTRIES: ${entries.length} > ${L.maxEntries}`);
  let total = 0;
  for (const e of entries) {
    total += e.usize;
    if (e.flags & 1) bad.push(`ENCRYPTED_ENTRY: ${e.name}`);
    if (/(^|[\\/])\.\.([\\/]|$)/.test(e.name) || e.name.startsWith('/') || e.name.startsWith('\\') || /^[a-zA-Z]:/.test(e.name))
      bad.push(`PATH_TRAVERSAL: ${e.name}`);
    if ((e.mode & 0xf000) === 0xa000) bad.push(`SYMLINK: ${e.name}`);
    if (NESTED.test(e.name)) bad.push(`NESTED_ARCHIVE: ${e.name}`);
    if (e.usize > L.maxEntry) bad.push(`ENTRY_TOO_LARGE: ${e.name}`);
    if (e.usize > 0 && (e.csize === 0 || e.usize / e.csize > L.maxEntryRatio)) bad.push(`ENTRY_RATIO: ${e.name}`);
    if (e.offset + 30 + e.csize > fileSize) bad.push(`BAD_OFFSET: ${e.name}`);
  }
  if (total > L.maxTotal) bad.push(`ARCHIVE_TOO_LARGE_UNCOMPRESSED: ${total}`);
  if (fileSize > 0 && total / fileSize > L.maxRatio) bad.push(`ARCHIVE_RATIO: ${(total / fileSize).toFixed(0)}:1`);
  // Overlapping entries (offsets must be distinct)
  const ordered = [...entries].sort((a, b) => a.offset - b.offset);
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i - 1].offset + 30 + ordered[i - 1].csize > ordered[i].offset) { bad.push('OVERLAPPING_ENTRIES'); break; }
  }
  return [...new Set(bad)];
}

/**
 * Inflate with a byte counter that aborts when output exceeds `limit` (declared sizes can lie).
 * Throws if actual output > min(limit, declared).
 */
export function inflateLimited(data: Buffer, method: number, limit: number): Buffer {
  if (method === 0) {
    if (data.length > limit) throw new Error('LYING_HEADER: stored data exceeds limit');
    return data;
  }
  if (method !== 8) throw new Error(`unsupported compression method ${method}`);
  // maxOutputLength makes zlib throw as soon as the counter is exceeded.
  const result = zlib.inflateRawSync(data, { maxOutputLength: Math.max(1, limit) });
  if (result.length > limit) throw new Error('LYING_HEADER: output exceeded declared size');
  return result;
}

/** Read one entry's data via ranged reads of its local header + payload, with the byte limit. */
export async function readEntry(e: ZipEntry, read: RangeReader, limit: number): Promise<Buffer> {
  const hdr = await read(e.offset, e.offset + 29);
  if (hdr.length !== 30 || hdr.readUInt32LE(0) !== 0x04034b50 || hdr.readUInt16LE(6) !== e.flags || hdr.readUInt16LE(8) !== e.method) {
    throw new Error('INCONSISTENT_HEADERS: bad local header');
  }
  const start = e.offset + 30 + hdr.readUInt16LE(26) + hdr.readUInt16LE(28);
  const comp = e.csize ? await read(start, start + e.csize - 1) : Buffer.alloc(0);
  const cap = Math.min(limit, e.usize);
  try {
    const out = inflateLimited(comp, e.method, cap);
    if (out.length !== e.usize) throw new Error('INCONSISTENT_HEADERS: size differs from declared');
    return out;
  } catch (err) {
    if ((err as any).code === 'ERR_BUFFER_TOO_LARGE') throw new Error('LYING_HEADER: output exceeded declared size');
    throw err;
  }
}
