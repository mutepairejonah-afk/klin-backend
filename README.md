# kiln-api

Backend REST + SSE API for the kiln-app frontend, implementing the surface
documented in `docs/BACKEND.md` (from the frontend repo) against a Supabase
Postgres database.

## What's here

- Full REST surface for sessions, connections/secrets, schedules,
  library/usage/audit, settings/members/memory, and GitHub/Google OAuth.
- SSE event stream (`GET /sessions/:id/events`) + replay, backed by an
  append-only `events` table (persist-before-broadcast, per §4).
- A **stub orchestrator** (`src/orchestrator/stub.ts`) that emits a canned
  event script when a session is created — swap it for the real agent loop
  (OpenHands or equivalent, per §5) once that's wired up. Nothing else needs
  to change; it talks to the rest of the system only through `emitEvent()`.
- Org-scoped RLS on every table in Postgres — the API mostly just forwards
  the caller's JWT to Supabase and lets Postgres enforce access.

## Not included

The agent loop, the sandbox runtime (OpenSandbox/Docker), and background
workers (BullMQ) — see `docs/BACKEND.md` §2 for those. This is the `api`
service only.

## Setup

```bash
npm install
cp .env.example .env
```

Then fill in `.env`:

- `SUPABASE_URL` / `SUPABASE_ANON_KEY` — already filled in for the
  `kiln-app` project created for you (`kynkpkhanabcxhjeqovh`).
- `SUPABASE_SERVICE_ROLE_KEY` — **you need to add this.** Get it from the
  Supabase dashboard → this project → Project Settings → API → service_role
  key. Never commit it or send it to the frontend; the server uses it only
  for writes that must bypass RLS (orchestrator events, the audit hash
  chain).
- `FRONTEND_URL` / `CORS_ORIGIN` — point at wherever the Vite dev server or
  deployed frontend runs.

For GitHub/Google sign-in to work, enable those providers in the Supabase
dashboard (Authentication → Providers) and set each provider's OAuth
callback URL to `<your-api-url>/api/auth/callback`.

```bash
npm run dev     # tsx watch, http://localhost:8787
npm run build && npm start   # production
```

Point the frontend at it by setting `VITE_API_BASE=http://localhost:8787/api`
in the frontend's `.env`.

## Database

The schema (`supabase/migrations/` in this folder, mirrored into the Supabase
project as migration `initial_schema`) implements every table in
`docs/BACKEND.md` §10, plus RLS policies and an on-signup trigger that
creates a personal org + owner membership for each new user.

To apply it to a different Supabase project, run `supabase/migrations/` followed
by `auto_provision_org_on_signup` (see the file's own comments) through the
SQL editor or the Supabase CLI.

## Auth model

- OAuth (GitHub/Google) via Supabase Auth's PKCE flow, session stored in an
  httpOnly cookie (`kiln_sess`) carrying the Supabase access token directly.
- Every request re-resolves the caller's org + role from `members` — a user
  who belongs to multiple orgs is currently pinned to whichever membership
  row is oldest. Add an org-switcher route if you need more than one.
- Roles are `owner` / `operator` / `viewer`, matching §9. `requireOperator`
  gates member management, connections, and secrets.

## Safety gates (§8)

The stub orchestrator doesn't hit any of the gated operations (force push,
destructive SQL, prod deploys, secrets, spend, package installs, untrusted
code, bulk third-party writes), so it never emits `approval.requested`. Once
the real agent loop is wired in, it should call `emitEvent(sessionId,
'approval.requested', {...})` and the session should not proceed past that
tool call until `POST /sessions/:id/approvals/:aid` resolves it — the route
for resolving approvals is already implemented.

## Realtime

The frontend can subscribe straight to Postgres changes with `supabase-js` (RLS applies), no custom WebSocket code:

```ts
supabase.channel('session-' + id)
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'events', filter: `session_id=eq.${id}` }, (p) => onEvent(p.new))
  .subscribe();
```

Realtime is enabled for `sessions`, `events`, `approvals`, `artifacts`, `sandboxes` (see `supabase/migrations/`).
