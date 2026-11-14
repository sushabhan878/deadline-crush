import { z } from 'zod';

export const loginSchema = z.object({ email: z.string().trim().max(254).email(), password: z.string().min(1).max(200) }).strict();
export const signupSchema = z.object({
  email: z.string().trim().max(254).email(), name: z.string().trim().min(1).max(100),
  password: z.string().min(8).max(200), joinCode: z.string().trim().min(1).max(128),
  teamName: z.string().trim().min(2).max(80).optional(), teamCode: z.string().trim().min(1).max(128).optional(),
}).strict();

const httpsUrl = z.string().max(2048).url().refine((u) => u.startsWith('https://'), 'https only');
export const metadataSchema = z.object({
  title: z.string().trim().min(3).max(120),
  description: z.string().max(5000),
  links: z.array(httpsUrl).max(20),
}).strict();

export const startUploadSchema = z.object({
  filename: z.string().min(1).max(255), size: z.number().int().positive(), contentType: z.string().max(200),
}).strict();
export const signPartsSchema = z.object({ partNumbers: z.array(z.number().int().positive()).min(1).max(20) }).strict();
export const completeSchema = z.object({
  parts: z.array(z.object({ n: z.number().int().positive(), etag: z.string().min(1).max(160) }).strict()).max(20),
}).strict();

export type Metadata = z.infer<typeof metadataSchema>;
