import argon2 from 'argon2';
import { pool } from './db';

const N = Number(process.env.TEAMS ?? 5);
const hash = await argon2.hash('password123', { type: argon2.argon2id });
const h = await pool.query(
  `INSERT INTO hackathons (name, join_code, starts_at, deadline_at)
   VALUES ('Demo Hackathon','DEMO', now() - interval '1 day', now() + interval '5 minutes')
   ON CONFLICT (join_code) DO UPDATE SET deadline_at = now() + interval '5 minutes' RETURNING id`);
const hid = h.rows[0].id;
await pool.query(
  `INSERT INTO users (email,name,password_hash,role) VALUES ('organizer@demo.test','Organizer',$1,'organizer')
   ON CONFLICT DO NOTHING`, [hash]);
for (let i = 1; i <= N; i++) {
  const t = await pool.query(
    `INSERT INTO teams (hackathon_id,name) VALUES ($1,$2)
     ON CONFLICT (hackathon_id,name) DO UPDATE SET name=EXCLUDED.name RETURNING id`, [hid, `Team ${i}`]);
  const tid = t.rows[0].id;
  await pool.query(`INSERT INTO submissions (team_id) VALUES ($1) ON CONFLICT DO NOTHING`, [tid]);
  const u = await pool.query(
    `INSERT INTO users (email,name,password_hash,role) VALUES ($1,$2,$3,'participant')
     ON CONFLICT (email) DO UPDATE SET name=EXCLUDED.name RETURNING id`,
    [`team${i}@demo.test`, `Member ${i}`, hash]);
  await pool.query(
    `INSERT INTO team_members (team_id,user_id,hackathon_id,role) VALUES ($1,$2,$3,'leader') ON CONFLICT DO NOTHING`,
    [tid, u.rows[0].id, hid]);
}
console.log(`seeded hackathon ${hid}; logins team1..team${N}@demo.test or organizer@demo.test, password: password123`);
await pool.end();
