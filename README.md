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

## AI providers (free tiers)

Set `OPENROUTER_API_KEY` and/or `GEMINI_API_KEY` (see `.env.example`). With at least one set, sessions run the
real agent in `src/orchestrator/agent.ts`; with none, the canned stub runs. Providers are tried in order and a
429/error falls through to the next. `POST /sessions` accepts an optional `agent: { slug, name, systemPrompt }`
(the specialist personas from agency-agents) which becomes the system prompt for that session.
The agent cannot yet execute code or touch a repo, and its prompt says so.

## API docs (Swagger)

- Interactive docs served by the backend itself: `/api/docs` (public, no login needed).
- Static copy on GitHub Pages, built from the same `docs/openapi.yaml`, so the two never drift apart.
- To update: edit `docs/openapi.yaml` and redeploy; both surfaces pick it up automatically.

## Auth (Clerk)

Sign-in is handled by Clerk on the frontend (email, Google, GitHub, Vercel — enable each as a
social connection in the Clerk Dashboard under SSO connections; email is on by default). The
frontend sends Clerk's session token as `Authorization: Bearer <token>`; the backend verifies it
with `CLERK_SECRET_KEY` (see `src/middleware/clerkAuth.ts`) and auto-creates an org for first-time
sign-ins, same as the old Supabase-Auth trigger did.

Because Clerk tokens aren't Supabase-signed JWTs, the backend now talks to Postgres with the
service-role key for every request and enforces org scoping in the Express layer (`req.orgId`)
rather than via RLS/`auth.uid()`. The RLS policies are left in the schema for a future migration
to [Supabase's native Clerk integration](https://clerk.com/docs/integrations/databases/supabase),
which would restore `auth.jwt()`-based RLS.

The old `/api/auth/*` Supabase-cookie OAuth routes are still mounted but unused — safe to remove
once Clerk is confirmed working end to end.

## Connectors

`GET /connections` merges a static catalog with each org's connected state. Only GitHub has a
real OAuth flow wired up so far (`/connections/github/start` + `/connections/github/callback`);
every other catalog entry (Neon, Supabase, Vercel, Fly, Stripe, ...) is still a stub connect that
just flips `connected=true` with no real token — each needs its own OAuth app registered the same
way before it's "real". OAuth tokens are stored encrypted (AES-256-GCM, `CONNECTION_ENC_KEY`) in
`connections.encrypted_credentials`, not in plaintext.

To wire up GitHub: create a GitHub OAuth App (github.com/settings/developers), callback URL
`<BACKEND_URL>/api/connections/github/callback`, then set `GITHUB_OAUTH_CLIENT_ID` /
`GITHUB_OAUTH_CLIENT_SECRET` on the backend.

## Research (no terminal needed)

Plain chat and research questions no longer pretend to need a sandbox/terminal — see the agent's
system prompt in `src/orchestrator/agent.ts`. A lightweight heuristic (`needsResearch` in
`src/lib/websearch.ts`) triggers a real, keyless web search (DuckDuckGo HTML) when a goal looks
like it needs current/factual info, and the results are fed into the model's answer. It's a free
scrape, not a paid search API — swap it out if quality matters more than cost.
