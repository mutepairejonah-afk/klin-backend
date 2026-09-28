import { Router } from 'express';
import crypto from 'node:crypto';
import { supabaseAdmin } from '../lib/supabase.js';
import { setSessionCookie, clearSessionCookie } from '../middleware/auth.js';

const router = Router();

const SUPABASE_URL = process.env.SUPABASE_URL!;
const ANON_KEY = process.env.SUPABASE_ANON_KEY!;
const FRONTEND_URL = process.env.FRONTEND_URL ?? 'http://localhost:5173';
const VERIFIER_COOKIE = 'kiln_pkce_verifier';

function base64url(input: Buffer) {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// GET /auth/:provider/start — kicks off Supabase's OAuth+PKCE flow.
router.get('/:provider/start', (req, res) => {
  const provider = req.params.provider;
  if (provider !== 'github' && provider !== 'google') {
    return res.status(400).json({ error: 'unsupported provider' });
  }

  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());

  res.cookie(VERIFIER_COOKIE, verifier, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === 'true',
    maxAge: 10 * 60 * 1000,
    path: '/api/auth/callback',
  });

  const redirectTo = `${req.protocol}://${req.get('host')}/api/auth/callback`;
  const authorizeUrl = new URL(`${SUPABASE_URL}/auth/v1/authorize`);
  authorizeUrl.searchParams.set('provider', provider);
  authorizeUrl.searchParams.set('redirect_to', redirectTo);
  authorizeUrl.searchParams.set('code_challenge', challenge);
  authorizeUrl.searchParams.set('code_challenge_method', 's256');

  res.redirect(authorizeUrl.toString());
});

// GET /auth/callback — Supabase redirects here with ?code=...
router.get('/callback', async (req, res) => {
  const code = req.query.code as string | undefined;
  const verifier = req.cookies?.[VERIFIER_COOKIE];
  res.clearCookie(VERIFIER_COOKIE, { path: '/api/auth/callback' });

  if (!code || !verifier) {
    return res.redirect(`${FRONTEND_URL}/sign-in?error=missing_code`);
  }

  const tokenRes = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=pkce`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ANON_KEY },
    body: JSON.stringify({ auth_code: code, code_verifier: verifier }),
  });

  if (!tokenRes.ok) {
    const detail = await tokenRes.text().catch(() => '');
    console.error('OAuth code exchange failed:', detail);
    return res.redirect(`${FRONTEND_URL}/sign-in?error=exchange_failed`);
  }

  const session = (await tokenRes.json()) as {
    access_token: string; refresh_token: string; expires_in: number;
  };

  setSessionCookie(res, session.access_token, session.expires_in * 1000);
  // Refresh token stored separately; wire a /auth/refresh route using it if
  // you want silent renewal instead of forcing re-login when it expires.
  res.cookie('kiln_refresh', session.refresh_token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === 'true',
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: '/api/auth',
  });

  res.redirect(FRONTEND_URL);
});

// GET /auth/me
router.get('/me', async (req, res) => {
  if (!req.user) return res.json(null);
  res.json({ id: req.user.id, name: req.user.name, email: req.user.email });
});

// POST /auth/signout
router.post('/signout', async (req, res) => {
  const token = req.cookies?.[process.env.SESSION_COOKIE_NAME ?? 'kiln_sess'];
  if (token) await supabaseAdmin.auth.admin.signOut(token).catch(() => {});
  clearSessionCookie(res);
  res.clearCookie('kiln_refresh', { path: '/api/auth' });
  res.status(204).end();
});

export default router;
