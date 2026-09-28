import type { NextFunction, Request, Response } from 'express';
import { supabaseAdmin, supabaseForUser } from '../lib/supabase.js';
import type { SupabaseClient } from '@supabase/supabase-js';

const COOKIE_NAME = process.env.SESSION_COOKIE_NAME ?? 'kiln_sess';

export interface AuthedUser {
  id: string;
  email: string;
  name: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthedUser;
      db?: SupabaseClient; // RLS-scoped client for this request
      orgId?: string;
      role?: 'owner' | 'operator' | 'viewer';
    }
  }
}

export function readSessionCookie(req: Request): string | undefined {
  return req.cookies?.[COOKIE_NAME];
}

export function setSessionCookie(res: Response, accessToken: string, maxAgeMs: number) {
  res.cookie(COOKIE_NAME, accessToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === 'true',
    maxAge: maxAgeMs,
    path: '/',
  });
}

export function clearSessionCookie(res: Response) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

/** Populates req.user/db/orgId/role when a valid session cookie is present. Does not reject if absent. */
export async function attachAuth(req: Request, _res: Response, next: NextFunction) {
  const token = readSessionCookie(req);
  if (!token) return next();

  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user) return next();

  req.user = {
    id: data.user.id,
    email: data.user.email ?? '',
    name: (data.user.user_metadata?.name as string) ?? data.user.email ?? '',
  };
  req.db = supabaseForUser(token);

  const { data: membership } = await supabaseAdmin
    .from('members')
    .select('org_id, role')
    .eq('user_id', data.user.id)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (membership) {
    req.orgId = membership.org_id as string;
    req.role = membership.role as 'owner' | 'operator' | 'viewer';
  }
  next();
}

/** Rejects the request unless attachAuth found a valid session + org membership. */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.user || !req.orgId || !req.db) {
    return res.status(401).json({ error: 'unauthenticated' });
  }
  next();
}

/** Rejects unless the caller's role is owner or operator (matches §9 RBAC). */
export function requireOperator(req: Request, res: Response, next: NextFunction) {
  if (req.role !== 'owner' && req.role !== 'operator') {
    return res.status(403).json({ error: 'forbidden — owner or operator role required' });
  }
  next();
}
