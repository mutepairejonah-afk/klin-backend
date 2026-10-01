import type { NextFunction, Request, Response } from 'express';
import { createClerkClient, verifyToken } from '@clerk/backend';
import { supabaseAdmin } from '../lib/supabase.js';

const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: { id: string; email: string; name: string };
      db?: import('@supabase/supabase-js').SupabaseClient; // service-role client; scope every query by req.orgId
      orgId?: string;
      role?: 'owner' | 'operator' | 'viewer';
    }
  }
}

function bearerToken(req: Request): string | undefined {
  const h = req.headers.authorization;
  if (h?.startsWith('Bearer ')) return h.slice(7);
  return undefined;
}

/**
 * Verifies the Clerk session token sent by the frontend (Authorization: Bearer <token>,
 * from Clerk's getToken()). On success, ensures an org exists for first-time users
 * (mirrors the old on-signup Postgres trigger, which only fired for Supabase Auth
 * signups and never fires for Clerk users) and populates req.user/db/orgId/role.
 * Does not reject if the token is absent or invalid — requireAuth does that.
 */
export async function attachClerkAuth(req: Request, _res: Response, next: NextFunction) {
  const token = bearerToken(req);
  if (!token) return next();

  let clerkUserId: string;
  try {
    const secretKey = process.env.CLERK_SECRET_KEY;
    if (!secretKey) throw new Error('CLERK_SECRET_KEY not set');
    const payload = await verifyToken(token, { secretKey });
    clerkUserId = payload.sub;
  } catch {
    return next(); // invalid/expired token — treated as signed out
  }

  // Cache Clerk's profile fields locally; nothing else can read auth.users anymore.
  let profile = { email: '', name: '' };
  const { data: cached } = await supabaseAdmin.from('clerk_users').select('*').eq('id', clerkUserId).maybeSingle();
  if (cached) {
    profile = { email: cached.email ?? '', name: cached.name ?? '' };
  } else {
    try {
      const cu = await clerk.users.getUser(clerkUserId);
      profile = {
        email: cu.emailAddresses.find((e) => e.id === cu.primaryEmailAddressId)?.emailAddress ?? cu.emailAddresses[0]?.emailAddress ?? '',
        name: [cu.firstName, cu.lastName].filter(Boolean).join(' ') || cu.username || '',
      };
      await supabaseAdmin.from('clerk_users').upsert({
        id: clerkUserId, email: profile.email, name: profile.name, avatar_url: cu.imageUrl, updated_at: new Date().toISOString(),
      });
    } catch (e) {
      console.error('clerk profile fetch failed', e);
    }
  }

  req.user = { id: clerkUserId, email: profile.email, name: profile.name || profile.email };
  req.db = supabaseAdmin; // no per-user RLS client for Clerk tokens — see migration notes

  let { data: membership } = await supabaseAdmin
    .from('members').select('org_id, role').eq('user_id', clerkUserId)
    .order('created_at', { ascending: true }).limit(1).maybeSingle();

  if (!membership) {
    // First sign-in: provision an org, same shape as the old auto-provision trigger.
    const { data: org, error: orgErr } = await supabaseAdmin
      .from('orgs').insert({ name: profile.name ? `${profile.name}'s org` : 'My org' }).select('id').single();
    if (!orgErr && org) {
      const { data: created } = await supabaseAdmin
        .from('members').insert({ org_id: org.id, user_id: clerkUserId, role: 'owner' }).select('org_id, role').single();
      membership = created ?? null;
      if (created) {
        await supabaseAdmin.from('user_settings').upsert({ org_id: org.id, user_id: clerkUserId, name: profile.name, email: profile.email });
      }
    }
  }

  if (membership) {
    req.orgId = membership.org_id as string;
    req.role = membership.role as 'owner' | 'operator' | 'viewer';
  }
  next();
}
