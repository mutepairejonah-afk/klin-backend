import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL!;
const ANON_KEY = process.env.SUPABASE_ANON_KEY!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPABASE_URL || !ANON_KEY) {
  throw new Error('SUPABASE_URL / SUPABASE_ANON_KEY missing — copy .env.example to .env and fill it in.');
}

// Service-role client: bypasses RLS. Used only for server-owned writes
// (orchestrator events, audit log hash chain, background workers).
// Never send this client's results back to a user without an org check —
// it does not filter by org on its own.
export const supabaseAdmin: SupabaseClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Per-request client: carries the caller's JWT so Postgres RLS policies
// (is_org_member / is_org_operator) enforce access — this is the client
// every route handler should use unless it's explicitly a server-owned write.
export function supabaseForUser(accessToken: string): SupabaseClient {
  return createClient(SUPABASE_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

export const supabaseAnon: SupabaseClient = createClient(SUPABASE_URL, ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
