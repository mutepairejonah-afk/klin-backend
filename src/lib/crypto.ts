import crypto from 'node:crypto';

// Reversible authenticated encryption for OAuth tokens and user secrets. The
// key must be explicitly configured in production; the development fallback is
// intentionally unavailable when NODE_ENV=production.
function key(): Buffer {
  const secret = process.env.CONNECTION_ENC_KEY;
  if (!secret && process.env.NODE_ENV === 'production') throw new Error('CONNECTION_ENC_KEY is required in production');
  return crypto.createHash('sha256').update(secret ?? 'dev-insecure-key-change-me').digest();
}

export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decrypt(blob: string): string {
  const buf = Buffer.from(blob, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

// Signed, expiring state for the OAuth redirect round-trip (CSRF protection +
// carries the org id across the browser redirect to GitHub and back, since
// GitHub's callback hits us with no Clerk auth header).
export function signState(payload: Record<string, unknown>): string {
  const json = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', key()).update(json).digest('base64url');
  return `${json}.${sig}`;
}

export function verifyState<T = any>(state: string, maxAgeMs = 10 * 60 * 1000): T | null {
  const [json, sig] = state.split('.');
  if (!json || !sig) return null;
  const expected = crypto.createHmac('sha256', key()).update(json).digest('base64url');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(json, 'base64url').toString('utf8'));
    if (typeof payload.ts !== 'number' || Date.now() - payload.ts > maxAgeMs) return null;
    return payload as T;
  } catch {
    return null;
  }
}
