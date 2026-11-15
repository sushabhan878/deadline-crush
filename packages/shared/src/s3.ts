import {
  S3Client, CreateMultipartUploadCommand, UploadPartCommand, ListPartsCommand,
  CompleteMultipartUploadCommand, AbortMultipartUploadCommand, HeadObjectCommand,
  GetObjectCommand, PutObjectCommand, DeleteObjectCommand, HeadBucketCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from './db';

const mk = (endpoint: string) => new S3Client({
  endpoint, region: config.s3.region, forcePathStyle: true, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
  credentials: { accessKeyId: config.s3.accessKey, secretAccessKey: config.s3.secretKey },
});
export const s3 = mk(config.s3.endpoint);
/** Signing uses the browser-reachable endpoint. */
const signer = mk(config.s3.publicEndpoint);
const Bucket = config.s3.bucket;
const attachment = (filename: string) => `attachment; filename="${filename.replace(/["\\\r\n]/g, '_')}"`;

export const storage = {
  /** Health probe for /status (F-15). */
  async ping() {
    try { await s3.send(new HeadBucketCommand({ Bucket })); return true; } catch { return false; }
  },
  async createMultipart(Key: string, filename: string) {
    const r = await s3.send(new CreateMultipartUploadCommand({
      Bucket, Key, ContentType: 'application/octet-stream', ContentDisposition: attachment(filename),
    }));
    return r.UploadId!;
  },
  signPart: (Key: string, UploadId: string, PartNumber: number, ContentLength: number, expiresIn: number) =>
    getSignedUrl(signer, new UploadPartCommand({ Bucket, Key, UploadId, PartNumber, ContentLength }), { expiresIn }),
  async listParts(Key: string, UploadId: string) {
    const out: { n: number; etag: string; size: number }[] = [];
    let marker: string | undefined;
    for (;;) { // paginated (1000/page)
      const r = await s3.send(new ListPartsCommand({ Bucket, Key, UploadId, PartNumberMarker: marker }));
      for (const p of r.Parts ?? []) out.push({ n: p.PartNumber!, etag: p.ETag!, size: Number(p.Size) });
      if (!r.IsTruncated) break;
      marker = String(r.NextPartNumberMarker);
    }
    return out;
  },
  complete: (Key: string, UploadId: string, parts: { n: number; etag: string }[]) =>
    s3.send(new CompleteMultipartUploadCommand({
      Bucket, Key, UploadId,
      MultipartUpload: { Parts: parts.map((p) => ({ PartNumber: p.n, ETag: p.etag })) },
    })),
  abort: (Key: string, UploadId: string) =>
    s3.send(new AbortMultipartUploadCommand({ Bucket, Key, UploadId })).catch(() => {}),
  async head(Key: string) {
    try { const r = await s3.send(new HeadObjectCommand({ Bucket, Key })); return { size: Number(r.ContentLength) }; }
    catch (error) {
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null;
      throw error;
    }
  },
  async rangeGet(Key: string, range: string): Promise<Buffer> {
    const r = await s3.send(new GetObjectCommand({ Bucket, Key, Range: range }));
    return Buffer.from(await r.Body!.transformToByteArray());
  },
  async stream(Key: string) {
    const r = await s3.send(new GetObjectCommand({ Bucket, Key }));
    return r.Body as NodeJS.ReadableStream;
  },
  put: (Key: string, Body: Buffer, ContentType: string) =>
    s3.send(new PutObjectCommand({ Bucket, Key, Body, ContentType })),
  del: (Key: string) => s3.send(new DeleteObjectCommand({ Bucket, Key })).catch(() => {}),
  downloadUrl: (Key: string, filename: string, expiresIn = 60) =>
    getSignedUrl(signer, new GetObjectCommand({
      Bucket, Key, ResponseContentDisposition: attachment(filename),
    }), { expiresIn }),
  previewUrl: (Key: string, expiresIn = 60) =>
    getSignedUrl(signer, new GetObjectCommand({ Bucket, Key }), { expiresIn }),
};
