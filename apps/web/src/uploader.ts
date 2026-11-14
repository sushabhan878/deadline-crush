import { api } from './api';
import { mockPut } from './mock';

const PART = 8 * 1024 * 1024;
const PARALLEL = 3;
const uploadKey = (sid: string) => `dc_up_${sid}`;
const fingerprint = (f: File) => JSON.stringify([f.name, f.size, f.lastModified]);
type SavedUpload = { fingerprint: string; filename: string; key: string; versionId?: string; versionNo?: number };
function readUpload(sid: string): SavedUpload | null {
  try { return JSON.parse(localStorage.getItem(uploadKey(sid)) ?? 'null'); } catch { return null; }
}
export const pendingUploadName = (sid: string) => readUpload(sid)?.filename;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FATAL = new Set(['GRACE_EXPIRED', 'VERSION_STATE_CONFLICT', 'DEADLINE_PASSED', 'NOT_A_MEMBER', 'VALIDATION', 'INVALID_PARTS']);

export interface UploadProgress {
  uploadedBytes: number; total: number; parts: Record<number, number>; totalParts: number;
  paused: boolean; resumed: boolean; retrying: number | null; versionNo: number;
}
export interface UploadHandle { cancel(): void; pause(): void; resume(): void; done: Promise<{ versionId: string; versionNo: number }> }

/** PUT one part with byte-level progress. Returns the ETag. */
function putPart(url: string, blob: Blob, onProgress: (loaded: number) => void, signal: AbortSignal): Promise<string> {
  if (signal.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'));
  if (url.startsWith('demo://')) return mockPut(url, blob.size, onProgress, signal);
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.timeout = 120_000;
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300
      ? resolve(xhr.getResponseHeader('ETag') ?? '')
      : reject(Object.assign(new Error(`Storage rejected part (${xhr.status})`), { status: xhr.status })));
    xhr.onerror = () => reject(new Error('Network error while uploading'));
    xhr.ontimeout = () => reject(new Error('Storage connection timed out'));
    xhr.onabort = () => reject(new DOMException('aborted', 'AbortError'));
    signal.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(blob);
  });
}

/** F-07: 8 MiB parts, 3 parallel, retry w/ backoff+jitter, resume from server part list, pause when offline. */
export function startUpload(submissionId: string, file: File, onProgress: (p: UploadProgress) => void, resumeOnly = false): UploadHandle {
  let cancelled = false, failed = false, userPaused = false, offline = !navigator.onLine;
  const inflight = new Set<AbortController>();
  const goOnline = () => { offline = false; emit(); }, goOffline = () => { offline = true; abortInflight(); emit(); };
  window.addEventListener('online', goOnline); window.addEventListener('offline', goOffline);
  const paused = () => userPaused || offline;
  const abortInflight = () => { inflight.forEach((c) => c.abort()); inflight.clear(); };
  const waitIfPaused = async () => { while (paused() && !cancelled) await sleep(250); };
  const retryNetwork = async <T>(action: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      await waitIfPaused();
      if (cancelled) throw Object.assign(new Error('Upload cancelled'), { code: 'CANCELLED' });
      try { return await action(); } catch (error: any) {
        if (attempt >= 5 || (error?.code !== 'NETWORK' && !(error?.status >= 500))) throw error;
        await sleep(400 * 2 ** attempt);
      }
    }
  };

  let versionId: string | undefined, versionNo = 0, totalParts = Math.max(1, Math.ceil(file.size / PART));
  let done: Record<number, number> = {}, live: Record<number, number> = {}, resumed = false, retrying: number | null = null;
  const emit = () => {
    const parts = { ...done, ...live };
    onProgress({
      uploadedBytes: Object.values(parts).reduce((a, b) => a + b, 0), total: file.size, parts, totalParts,
      paused: paused(), resumed, retrying, versionNo,
    });
  };

  const run = (async () => {
    try {
      let saved = readUpload(submissionId);
      if (saved?.fingerprint !== fingerprint(file)) {
        if (resumeOnly) throw new Error('Choose the original file to resume this upload.');
        saved = { fingerprint: fingerprint(file), filename: file.name, key: crypto.randomUUID() };
        localStorage.setItem(uploadKey(submissionId), JSON.stringify(saved));
      }
      versionId = saved.versionId;
      versionNo = saved.versionNo ?? 0;
      let missing: number[] = [];
      if (versionId) {
        const p = await retryNetwork(() => api(`/versions/${versionId}/parts`));
        if (p.status === 'uploading' || p.status === 'completing') {
          missing = p.missing; resumed = true;
          for (const u of p.uploaded) done[u.n] = u.size ?? Math.min(PART, file.size - (u.n - 1) * PART);
          totalParts = p.uploaded.length + p.missing.length;
        } else if (['uploaded', 'checking', 'accepted', 'needs_fix'].includes(p.status)) {
          localStorage.removeItem(uploadKey(submissionId));
          return { versionId, versionNo };
        } else {
          localStorage.removeItem(uploadKey(submissionId));
          throw new Error(`This upload is ${p.status}. ${resumeOnly ? 'The upload window has closed.' : 'Choose the file again to start a new version.'}`);
        }
      }
      if (!versionId) {
        const key = saved.key;
        const v = await retryNetwork(() => api(`/submissions/${submissionId}/versions`, {
          body: { filename: file.name, size: file.size, contentType: file.type || 'application/octet-stream' },
          headers: { 'Idempotency-Key': key },
        }));
        versionId = v.versionId; versionNo = v.versionNo; totalParts = v.totalParts;
        if (cancelled) {
          await api(`/versions/${versionId}/abort`, { body: {} }).catch(() => {});
          throw Object.assign(new Error('Upload cancelled'), { code: 'CANCELLED' });
        }
        localStorage.setItem(uploadKey(submissionId), JSON.stringify({ ...saved, versionId, versionNo }));
        missing = Array.from({ length: v.totalParts }, (_, i) => i + 1);
        done = {};
      }
      emit();

      const queue = [...missing];
      const worker = async () => {
        while (queue.length && !cancelled && !failed) {
          const n = queue.shift()!;
          for (let attempt = 0; ; attempt++) {
            await waitIfPaused();
            if (cancelled || failed) return;
            const ctrl = new AbortController();
            inflight.add(ctrl);
            try {
              const { urls } = await api(`/versions/${versionId}/parts/sign`, { body: { partNumbers: [n] } });
              const blob = file.slice((n - 1) * PART, Math.min(file.size, n * PART));
              await putPart(urls[0].url, blob, (loaded) => { live[n] = loaded; emit(); }, ctrl.signal);
              delete live[n]; done[n] = blob.size; retrying = null; emit();
              break;
            } catch (e: any) {
              delete live[n]; emit();
              if (cancelled || failed) return;
              if (e?.name === 'AbortError') { attempt--; continue; }
              if (FATAL.has(e?.code) || attempt >= 5) throw e;
              retrying = n; emit();
              await sleep(Math.min(30_000, 500 * 2 ** attempt) * (0.5 + Math.random())); // backoff + jitter
            } finally { inflight.delete(ctrl); }
          }
        }
      };
      await Promise.all(Array.from({ length: PARALLEL }, worker));
      if (cancelled) throw Object.assign(new Error('Upload cancelled'), { code: 'CANCELLED' });

      // Complete with the server's view of parts (source of truth for ETags).
      const listed = await retryNetwork(() => api(`/versions/${versionId}/parts`));
      const r = await retryNetwork(() => api(`/versions/${versionId}/complete`, { body: { parts: listed.uploaded.map((u: any) => ({ n: u.n, etag: u.etag })) } }));
      localStorage.removeItem(uploadKey(submissionId));
      return { versionId: versionId!, versionNo: r.versionNo ?? versionNo };
    } catch (e: any) {
      failed = true; abortInflight();
      if (['GRACE_EXPIRED', 'DEADLINE_PASSED'].includes(e?.code)) localStorage.removeItem(uploadKey(submissionId));
      throw e;
    } finally {
      window.removeEventListener('online', goOnline); window.removeEventListener('offline', goOffline);
    }
  })();

  return {
    done: run,
    cancel: () => {
      if (cancelled) return;
      cancelled = true; abortInflight();
      localStorage.removeItem(uploadKey(submissionId));
      if (versionId) void api(`/versions/${versionId}/abort`, { method: 'POST', body: {} }).catch(() => {});
    },
    pause: () => { userPaused = true; abortInflight(); emit(); },
    resume: () => { userPaused = false; emit(); },
  };
}
