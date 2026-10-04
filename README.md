# kiln-api

Backend REST + SSE API for the kiln-app frontend, implementing the surface
documented in `docs/BACKEND.md` (from the frontend repo) against a Supabase
Postgres database.

## What's here

- Full REST surface for sessions, connections/secrets, schedules,
  library/usage/audit, settings/members/memory, and GitHub/Google OAuth.
- SSE event stream (`GET /sessions/:id/events`) + replay, backed by an
  append-only `events` table (persist-before-broadcast, per §4).
- A guarded orchestration boundary. If no model/runtime is configured, a
  session fails explicitly; it never emits fake edits, test results, commits,
  or pull requests. The real tool-running agent still needs to be connected
  before coding sessions are advertised as executable.
- Clerk bearer tokens are verified at the API boundary; because Clerk tokens
  are not Supabase JWTs, request handlers use the service-role client and must
  explicitly scope every query by `req.orgId`. This is also documented as a
  migration target for native Clerk/Supabase RLS.

## Execution plane

The backend now includes a Docker-isolated execution plane. Coding sessions
are persisted as Supabase `execution_jobs`; a standalone `ExecutionWorker`
claims them and provisions one non-root container and workspace volume per
session. Filesystem, shell, Git, and test tools are exposed through
`src/tools/sandboxTools.ts`. The local Compose worker is disabled from the API
by default; enable it with the `KILN_EXECUTION_*` settings in `.env.example`.

See [`docs/EXECUTION.md`](docs/EXECUTION.md) for the isolation model, threat
boundaries, Supabase queue, local Compose setup, and OpenSandbox replacement
seam.

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

The deployment must apply the core schema plus the numbered integrity,
approval-scope, and execution-queue migrations in
`supabase/migrations/0002_event_integrity.sql`, `0003_approval_org_scope.sql`,
`0004_execution_jobs.sql`, `0005_execution_compute_config.sql`, and
`0006_clerk_invitations.sql`. These add
the unique `(session_id, seq)` event invariant, approval organization scope,
atomic worker job claiming, heavy-compute lease/resource policy, and Clerk
pending-invitation handoff. Keep the
database schema versioned alongside this service; do not rely on an invisible
dashboard-only migration.

See [`docs/SUPABASE_COMPUTE.md`](docs/SUPABASE_COMPUTE.md) for the Supabase
control-plane configuration. Supabase stores and coordinates heavy jobs; the
Docker/OpenSandbox worker performs the actual CPU- and memory-intensive work.

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

The coding executor now calls the isolated filesystem, shell, Git, and test
tools one action at a time. Commits emit `approval.requested` and block until
`POST /sessions/:id/approvals/:aid` resolves it. The route is role-gated,
org-scoped, and only updates a still-pending approval.

## Realtime

The frontend uses the API's authenticated SSE stream. Do not expose the
Supabase service-role client or put Clerk tokens in query strings. A
multi-instance deployment should move the in-memory fan-out in
`src/lib/eventBus.ts` to Redis or Postgres LISTEN/NOTIFY.

```ts
supabase.channel('session-' + id)
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'events', filter: `session_id=eq.${id}` }, (p) => onEvent(p.new))
  .subscribe();
```

Realtime is enabled for `sessions`, `events`, `approvals`, `artifacts`, `sandboxes` (see `supabase/migrations/`).

## AI providers (free tiers)

Set `OPENROUTER_API_KEY` and/or `GEMINI_API_KEY` (see `.env.example`). With at least one set, sessions run the
current chat/research agent in `src/orchestrator/agent.ts`; with none, sessions fail explicitly rather than
pretending to execute. Providers are tried in order and a
429/error falls through to the next. `POST /sessions` accepts an optional `agent: { slug, name, systemPrompt }`
(the specialist personas from agency-agents) which becomes the system prompt for that session.
Coding sessions use the JSON executor loop when the Docker execution plane is
enabled; plain chat/research sessions continue to use the chat agent.

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
real OAuth flow wired up so far (`/connections/github/start` + `/connections/github/callback`).
Unsupported providers return `501` and remain disconnected; they no longer create fake
credentials. OAuth tokens and user secrets are stored encrypted (AES-256-GCM,
`CONNECTION_ENC_KEY`) in
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

## Model (per-person override)

`Settings -> Model` lets a person pick a specific provider/model; it's stored in
`user_settings.model_routing` as `{ provider, model }` and read by `POST /sessions`, which passes
it to `runAgent` as a `ModelOverride`. The chosen provider is tried first; everything still falls
back through the other configured providers on failure, so picking "Ollama" doesn't break a
session if Ollama is briefly down. `GET /models` tells the frontend which providers actually have
a key set on the server, so the picker doesn't offer a dead option.

Fourth provider: **Ollama Cloud** (`OLLAMA_API_KEY`, ollama.com/settings/keys) — hosted open
models (gpt-oss, Kimi, DeepSeek, ...) behind an OpenAI-compatible endpoint, same shape as
OpenRouter/Gemini in `src/lib/llm.ts`. Has a free tier.

## Deleting a session

`DELETE /sessions/:id` removes the row (org-scoped) and closes any open SSE stream for it first,
so a client watching a session that gets deleted mid-run sees the connection end cleanly instead
of erroring.
