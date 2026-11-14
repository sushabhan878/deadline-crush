import assert from 'node:assert/strict';
import argon2 from 'argon2';
import { pool, withTx } from '@dc/shared';

const { EVENT_NAME, EVENT_JOIN_CODE, EVENT_DEADLINE, ORGANIZER_EMAIL, ORGANIZER_PASSWORD } = process.env;
assert(EVENT_NAME && EVENT_JOIN_CODE && EVENT_DEADLINE && ORGANIZER_EMAIL && ORGANIZER_PASSWORD);
const deadline = new Date(EVENT_DEADLINE);
assert(/^\d{4}-\d{2}-\d{2}T.*Z$/.test(EVENT_DEADLINE) && Number.isFinite(deadline.getTime()), 'EVENT_DEADLINE must be an ISO UTC timestamp');
assert(ORGANIZER_PASSWORD.length >= 16 && EVENT_JOIN_CODE !== 'DEMO', 'Use a private join code and a strong organizer password');
const hash = await argon2.hash(ORGANIZER_PASSWORD);
try {
  await withTx(async (tx) => {
    const existing = await tx.query('SELECT 1 FROM hackathons WHERE join_code=$1', [EVENT_JOIN_CODE]);
    if (!existing.rowCount) assert(deadline.getTime() > Date.now(), 'A new event requires a future deadline');
    await tx.query(`INSERT INTO hackathons(name,join_code,starts_at,deadline_at) VALUES ($1,$2,now(),$3)
      ON CONFLICT (join_code) DO NOTHING`, [EVENT_NAME, EVENT_JOIN_CODE, deadline]);
    await tx.query(`INSERT INTO users(email,name,password_hash,role) VALUES ($1,'Organizer',$2,'organizer')
      ON CONFLICT (email) DO NOTHING`, [ORGANIZER_EMAIL.toLowerCase(), hash]);
  });
  console.log('Event and organizer initialized');
} finally { await pool.end(); }
