import { CreateBucketCommand } from '@aws-sdk/client-s3';
import { setTimeout as delay } from 'node:timers/promises';
import { config, s3, storage } from '@dc/shared';

for (let i = 1; ; i++) {
  if (await storage.ping()) break;
  try { await s3.send(new CreateBucketCommand({ Bucket: config.s3.bucket })); break; }
  catch (error) { if (i === 20) throw error; await delay(500); }
}
