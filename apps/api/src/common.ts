import 'reflect-metadata';
import {
  CanActivate, ExecutionContext, Injectable, Catch, ExceptionFilter, ArgumentsHost, createParamDecorator,
} from '@nestjs/common';
import jwt from 'jsonwebtoken';
import { z, ZodSchema } from 'zod';
import { randomUUID } from 'node:crypto';
import { AppError, audit, config, pool, withTx } from '@dc/shared';

export interface AuthUser { id: string; role: 'participant' | 'organizer' | 'admin'; email: string }

export function parse<T>(schema: ZodSchema<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new AppError('VALIDATION', 'Invalid input', r.error.flatten());
  return r.data;
}
export const uuidParam = (v: string) => parse(z.string().uuid(), v);

export const signAccess = (u: AuthUser) => jwt.sign(u, config.jwtSecret, { expiresIn: '15m' });

@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest();
    const h: string | undefined = req.headers.authorization;
    const token = h?.startsWith('Bearer ') ? h.slice(7) : undefined;
    if (!token) throw new AppError('UNAUTHORIZED', 'Missing token');
    try {
      req.user = jwt.verify(token, config.jwtSecret) as AuthUser;
    } catch {
      throw new AppError('UNAUTHORIZED', 'Invalid or expired token');
    }
    return true;
  }
}

@Injectable()
export class OrganizerGuard implements CanActivate {
  canActivate(ctx: ExecutionContext) {
    const u = ctx.switchToHttp().getRequest().user as AuthUser | undefined;
    if (!u || u.role === 'participant') throw new AppError('FORBIDDEN', 'Organizer only');
    return true;
  }
}

/**
 * Reusable membership guard (F-02). Resolves the team from :teamId, :id (submission),
 * or version id depending on route prefix, and attaches req.ctx.
 */
@Injectable()
export class TeamMemberGuard implements CanActivate {
  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest();
    const u = req.user as AuthUser;
    const id = uuidParam(req.params.id);
    const kind: string = req.route.path.split('/')[1]; // submissions | versions | teams
    const sql =
      kind === 'teams'
        ? `SELECT t.id AS team_id, t.hackathon_id, s.id AS submission_id FROM teams t JOIN submissions s ON s.team_id=t.id WHERE t.id=$1`
        : kind === 'submissions'
        ? `SELECT t.id AS team_id, t.hackathon_id, s.id AS submission_id FROM submissions s JOIN teams t ON t.id=s.team_id WHERE s.id=$1`
        : `SELECT t.id AS team_id, t.hackathon_id, s.id AS submission_id FROM file_versions v JOIN submissions s ON s.id=v.submission_id JOIN teams t ON t.id=s.team_id WHERE v.id=$1`;
    const r = await pool.query(sql, [id]);
    if (!r.rowCount) throw new AppError('NOT_FOUND', 'Not found');
    const row = r.rows[0];
    if (u.role === 'participant' || req.method !== 'GET') {
      const m = await pool.query('SELECT 1 FROM team_members WHERE team_id=$1 AND user_id=$2', [row.team_id, u.id]);
      if (!m.rowCount) throw new AppError('NOT_A_MEMBER', 'Not a member of this team');
    }
    req.ctx = { teamId: row.team_id, hackathonId: row.hackathon_id, submissionId: row.submission_id };
    return true;
  }
}

export const User = createParamDecorator((_d, ctx: ExecutionContext) => ctx.switchToHttp().getRequest().user);
export const TeamCtx = createParamDecorator((_d, ctx: ExecutionContext) => ctx.switchToHttp().getRequest().ctx);
export const Ip = createParamDecorator((_d, ctx: ExecutionContext) => ctx.switchToHttp().getRequest().ip);

@Catch()
export class AllExceptions implements ExceptionFilter {
  catch(e: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();
    const requestId = randomUUID();
    if (e instanceof AppError) {
      return res.status(e.status).json({ code: e.code, message: e.message, details: e.details, requestId });
    }
    const status = (e as any)?.getStatus?.() ?? 500;
    if (status === 500) console.error(JSON.stringify({ requestId, err: String((e as Error)?.stack ?? e) }));
    res.status(status).json({ code: status === 500 ? 'INTERNAL' : 'VALIDATION', message: status === 500 ? 'Internal error' : (e as Error).message, requestId });
  }
}

/** Log a rejected action (late_attempts, PRD §5.8). Written outside the failed tx. */
export async function logLate(
  teamId: string, userId: string, action: string, now: Date, deadline: Date, reason: string, ip?: string,
) {
  await withTx(async (tx) => {
    const deltaMs = Math.max(0, now.getTime() - deadline.getTime());
    await tx.query(`INSERT INTO late_attempts (team_id,user_id,action,server_time,deadline_at,delta_ms,reason,ip)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [teamId, userId, action, now, deadline, deltaMs, reason, ip ?? null]);
    const { rows: [team] } = await tx.query('SELECT hackathon_id FROM teams WHERE id=$1', [teamId]);
    await audit(tx, team.hackathon_id, teamId, userId, 'submission.late_attempt', { action, reason, deltaMs });
  });
}
