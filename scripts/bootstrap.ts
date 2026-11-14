import assert from 'node:assert/strict';
import argon2 from 'argon2';
import { pool, withTx } from '@dc/shared';

const { EVENT_NAME, EVENT_JOIN_CODE, EVENT_DEADLINE, ORGANIZER_EMAIL, ORGANIZER_PASSWORD } = process.env;
assert(EVENT_NAME && EVENT_JOIN_CODE && EVENT_DEADLINE && ORGANIZER_EMAIL && ORGANIZER_PASSWORD);
const deadline = new Date(EVENT_DEADLINE);
assert(Number.isFinite(deadline.getTime()) && deadline.getTime() > Date.now(), 'EVENT_DEADLINE must be a future ISO timestamp');
assert(ORGANIZER_PASSWORD.length >= 16 && EVENT_JOIN_CODE !== 'DEMO', 'Use a private join code and a strong organizer password');
const hash = await argon2.hash(ORGANIZER_PASSWORD);
try {
  await withTx(async (tx) => {
    await tx.query(`INSERT INTO hackathons(name,join_code,starts_at,deadline_at) VALUES ($1,$2,now(),$3)
      ON CONFLICT (join_code) DO NOTHING`, [EVENT_NAME, EVENT_JOIN_CODE, deadline]);
    await tx.query(`INSERT INTO users(email,name,password_hash,role) VALUES ($1,'Organizer',$2,'organizer')
      ON CONFLICT (email) DO NOTHING`, [ORGANIZER_EMAIL.toLowerCase(), hash]);
  });
  console.log('Event and organizer initialized');
} finally { await pool.end(); }
