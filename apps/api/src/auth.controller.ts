import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import argon2 from 'argon2';
import { AppError, loginSchema, signupSchema, pool, withTx, audit } from '@dc/shared';
import { AuthGuard, AuthUser, User, parse, signAccess } from './common';

// F-01 login rate limit: 10/min per IP+email (in-memory; use Redis/PG when scaling API horizontally).
const attempts = new Map<string, number[]>();
function rateLimit(key: string, max: number, windowMs = 60_000) {
  const now = Date.now();
  const arr = (attempts.get(key) ?? []).filter((t) => now - t < windowMs);
  if (arr.length >= max) throw new AppError('RATE_LIMITED', 'Too many attempts');
  arr.push(now);
  attempts.set(key, arr);
}
const cleanup = setInterval(() => {
  const oldest = Date.now() - 60_000;
  for (const [key, times] of attempts) if (times.at(-1)! < oldest) attempts.delete(key);
}, 60_000);
cleanup.unref();

@Controller('auth')
export class AuthController {
  @Post('login')
  async login(@Body() body: unknown, @Req() req: any) {
    const { email, password } = parse(loginSchema, body);
    rateLimit(`ip|${req.ip}`, 120);
    rateLimit(`${req.ip}|${email.toLowerCase()}`, 10);
    const r = await pool.query('SELECT * FROM users WHERE email=$1', [email.toLowerCase()]);
    const u = r.rows[0];
    if (!u || !(await argon2.verify(u.password_hash, password))) throw new AppError('UNAUTHORIZED', 'Invalid credentials');
    const user: AuthUser = { id: u.id, role: u.role, email: u.email };
    return { token: signAccess(user), user: { ...user, name: u.name } };
  }

  /** Participant signup with hackathon join code; creates a team or joins one via invite code. */
  @Post('signup')
  async signup(@Body() body: unknown, @Req() req: any) {
    const b = parse(signupSchema, body);
    rateLimit(`signup|${req.ip}`, 30);
    const h = await pool.query('SELECT id FROM hackathons WHERE join_code=$1', [b.joinCode]);
    if (!h.rowCount) throw new AppError('FORBIDDEN', 'Invalid join code');
    const hid = h.rows[0].id;
    const hash = await argon2.hash(b.password, { type: argon2.argon2id });
    const user = await withTx(async (tx) => {
      const u = await tx.query(
        `INSERT INTO users (email,name,password_hash,role) VALUES ($1,$2,$3,'participant')
         ON CONFLICT (email) DO NOTHING RETURNING id,email,role`, [b.email.toLowerCase(), b.name, hash]);
      if (!u.rowCount) throw new AppError('VALIDATION', 'Email already registered');
      let teamId: string, role = 'member';
      if (b.teamCode) {
        const t = await tx.query('SELECT id FROM teams WHERE invite_code=$1 AND hackathon_id=$2', [b.teamCode, hid]);
        if (!t.rowCount) throw new AppError('NOT_FOUND', 'Invalid team code');
        teamId = t.rows[0].id;
      } else if (b.teamName) {
        const t = await tx.query(
          `INSERT INTO teams (hackathon_id,name) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING id`, [hid, b.teamName]);
        if (!t.rowCount) throw new AppError('VALIDATION', 'Team name taken');
        teamId = t.rows[0].id; role = 'leader';
        await tx.query('INSERT INTO submissions (team_id) VALUES ($1)', [teamId]);
      } else throw new AppError('VALIDATION', 'teamName or teamCode required');
      await tx.query('INSERT INTO team_members (team_id,user_id,hackathon_id,role) VALUES ($1,$2,$3,$4)', [teamId, u.rows[0].id, hid, role]);
      await audit(tx, hid, teamId, u.rows[0].id, 'team.member_joined');
      return u.rows[0] as AuthUser;
    });
    return { token: signAccess(user), user };
  }
}

@Controller()
export class MeController {
  @Get('me')
  @UseGuards(AuthGuard)
  async me(@User() u: AuthUser) {
    const r = await pool.query(
      `SELECT t.id AS team_id, t.name AS team_name, t.invite_code, t.hackathon_id, s.id AS submission_id
       FROM team_members m JOIN teams t ON t.id=m.team_id JOIN submissions s ON s.team_id=t.id WHERE m.user_id=$1`, [u.id]);
    return { user: u, team: r.rows[0] ?? null };
  }
}
