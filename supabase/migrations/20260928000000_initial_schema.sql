-- kiln-app schema — implements docs/BACKEND.md §10
-- Org-scoped multi-tenant model on top of Supabase auth.users

create extension if not exists "pgcrypto";
create extension if not exists "vector";

-- ---------------------------------------------------------------------------
-- Orgs & members
-- ---------------------------------------------------------------------------
create table orgs (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  created_at  timestamptz not null default now()
);

create table members (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references orgs(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  role        text not null check (role in ('owner','operator','viewer')),
  created_at  timestamptz not null default now(),
  unique (org_id, user_id)
);

create index members_org_idx on members(org_id);
create index members_user_idx on members(user_id);

-- ---------------------------------------------------------------------------
-- Sessions & events (the replay/share source of truth)
-- ---------------------------------------------------------------------------
create table sessions (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references orgs(id) on delete cascade,
  user_id       uuid not null references auth.users(id),
  goal          text not null,
  status        text not null default 'queued'
                check (status in ('queued','planning','executing','waiting_approval',
                                   'verifying','paused','done','failed')),
  job_id        text,
  repo          text,
  branch        text,
  connectors    text[] not null default '{}',
  sandbox_id    uuid,
  cost_usd      numeric(10,4) default 0,
  duration_sec  integer,
  share_token   uuid,
  share_public  boolean not null default false,
  created_at    timestamptz not null default now(),
  ended_at      timestamptz
);

create index sessions_org_idx on sessions(org_id, created_at desc);
create index sessions_status_idx on sessions(org_id, status);
create unique index sessions_share_token_idx on sessions(share_token) where share_token is not null;

create table events (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid not null references sessions(id) on delete cascade,
  seq         integer not null,
  type        text not null,
  payload     jsonb not null default '{}',
  ts          timestamptz not null default now(),
  unique (session_id, seq)
);

create index events_session_seq_idx on events(session_id, seq);

create table artifacts (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid not null references sessions(id) on delete cascade,
  org_id      uuid not null references orgs(id) on delete cascade,
  kind        text not null check (kind in ('pr','diff','file','schema','preview','test','screenshot')),
  title       text not null,
  meta        text,
  url         text,
  created_at  timestamptz not null default now()
);

create index artifacts_session_idx on artifacts(session_id);
create index artifacts_org_kind_idx on artifacts(org_id, kind, created_at desc);

create table approvals (
  id            uuid primary key default gen_random_uuid(),
  session_id    uuid not null references sessions(id) on delete cascade,
  event_id      uuid references events(id) on delete set null,
  title         text not null,
  body          text not null,
  command       text,
  rollback      text,
  blast_radius  text,
  status        text not null default 'pending' check (status in ('pending','approved','rejected')),
  requested_at  timestamptz not null default now(),
  resolved_at   timestamptz,
  resolved_by   uuid references auth.users(id)
);

create index approvals_session_idx on approvals(session_id);
create index approvals_pending_idx on approvals(session_id, status);

create table sandboxes (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid not null references sessions(id) on delete cascade,
  provider    text not null default 'opensandbox',
  machine_id  text,
  region      text,
  status      text not null default 'provisioning'
              check (status in ('provisioning','running','idle','paused','destroyed')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table sessions
  add constraint sessions_sandbox_fk foreign key (sandbox_id) references sandboxes(id) on delete set null;

-- ---------------------------------------------------------------------------
-- Connections & secrets (org-scoped, handle-only for secrets)
-- ---------------------------------------------------------------------------
create table connections (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null references orgs(id) on delete cascade,
  provider              text not null,
  encrypted_credentials text,
  scopes                text[] not null default '{}',
  connected             boolean not null default false,
  meta                  text,
  connected_at          timestamptz,
  last_used_at          timestamptz,
  unique (org_id, provider)
);

create table secrets (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references orgs(id) on delete cascade,
  handle            text not null,
  encrypted_value   text not null,
  scope             text not null,
  created_at        timestamptz not null default now(),
  last_used_at      timestamptz,
  unique (org_id, handle)
);

create index secrets_org_idx on secrets(org_id);

-- ---------------------------------------------------------------------------
-- Schedules
-- ---------------------------------------------------------------------------
create table schedules (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references orgs(id) on delete cascade,
  name          text not null,
  job_id        text not null,
  repo          text,
  cadence_label text not null,
  cadence_cron  text not null,
  next_run_at   timestamptz,
  enabled       boolean not null default true,
  created_at    timestamptz not null default now()
);

create index schedules_org_idx on schedules(org_id);
create index schedules_due_idx on schedules(next_run_at) where enabled;

-- ---------------------------------------------------------------------------
-- Settings, memory, repo index
-- ---------------------------------------------------------------------------
create table user_settings (
  org_id            uuid not null references orgs(id) on delete cascade,
  user_id           uuid not null references auth.users(id) on delete cascade,
  name              text,
  email             text,
  test_framework    text default 'auto',
  commit_style      text default 'conventional',
  branch_naming     text default 'kiln/{job}-{slug}',
  model_routing     jsonb not null default '{"planner":"claude-sonnet-4-6","executor":"claude-sonnet-4-6","critic":"claude-sonnet-4-6","retriever":"claude-sonnet-4-6"}',
  network_allowlist text[] not null default '{}',
  approval_rules    jsonb not null default '{}',
  primary key (org_id, user_id)
);

create table user_memory (
  org_id      uuid not null references orgs(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  key         text not null,
  value       text not null,
  updated_at  timestamptz not null default now(),
  primary key (org_id, user_id, key)
);

create table org_memory (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references orgs(id) on delete cascade,
  text        text not null,
  kind        text not null default 'note',
  created_at  timestamptz not null default now()
);

create index org_memory_org_idx on org_memory(org_id);

create table repo_index (
  org_id      uuid not null references orgs(id) on delete cascade,
  repo        text not null,
  files       integer not null default 0,
  symbols     integer not null default 0,
  indexed_at  timestamptz,
  stale       boolean not null default true,
  embedding   vector(1536),
  primary key (org_id, repo)
);

-- ---------------------------------------------------------------------------
-- Audit log (append-only, signed hash chain)
-- ---------------------------------------------------------------------------
create table audit_logs (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references orgs(id) on delete cascade,
  actor       text not null,
  action      text not null,
  session_id  uuid references sessions(id) on delete set null,
  detail      text,
  ip          text,
  ts          timestamptz not null default now(),
  prev_hash   text,
  hash        text not null
);

create index audit_logs_org_idx on audit_logs(org_id, ts desc);

-- ---------------------------------------------------------------------------
-- Row Level Security — org-scoped access via membership
-- ---------------------------------------------------------------------------
create or replace function is_org_member(target_org uuid) returns boolean
language sql security definer stable as $$
  select exists (
    select 1 from members m where m.org_id = target_org and m.user_id = auth.uid()
  );
$$;

create or replace function is_org_operator(target_org uuid) returns boolean
language sql security definer stable as $$
  select exists (
    select 1 from members m where m.org_id = target_org and m.user_id = auth.uid()
      and m.role in ('owner','operator')
  );
$$;

alter table orgs enable row level security;
alter table members enable row level security;
alter table sessions enable row level security;
alter table events enable row level security;
alter table artifacts enable row level security;
alter table approvals enable row level security;
alter table sandboxes enable row level security;
alter table connections enable row level security;
alter table secrets enable row level security;
alter table schedules enable row level security;
alter table user_settings enable row level security;
alter table user_memory enable row level security;
alter table org_memory enable row level security;
alter table repo_index enable row level security;
alter table audit_logs enable row level security;

create policy org_read on orgs for select using (is_org_member(id));
create policy members_read on members for select using (is_org_member(org_id));
create policy members_write on members for all using (is_org_operator(org_id)) with check (is_org_operator(org_id));

create policy sessions_read on sessions for select using (is_org_member(org_id));
create policy sessions_write on sessions for all using (is_org_member(org_id)) with check (is_org_member(org_id));

create policy events_read on events for select using (
  exists (select 1 from sessions s where s.id = events.session_id and is_org_member(s.org_id))
);
-- events are inserted by the service role (orchestrator) only, never directly by clients.

create policy artifacts_read on artifacts for select using (is_org_member(org_id));
create policy approvals_rw on approvals for all using (
  exists (select 1 from sessions s where s.id = approvals.session_id and is_org_member(s.org_id))
) with check (
  exists (select 1 from sessions s where s.id = approvals.session_id and is_org_operator(s.org_id))
);
create policy sandboxes_read on sandboxes for select using (
  exists (select 1 from sessions s where s.id = sandboxes.session_id and is_org_member(s.org_id))
);

create policy connections_rw on connections for all using (is_org_operator(org_id)) with check (is_org_operator(org_id));
create policy secrets_rw on secrets for all using (is_org_operator(org_id)) with check (is_org_operator(org_id));
create policy schedules_rw on schedules for all using (is_org_member(org_id)) with check (is_org_member(org_id));

create policy user_settings_rw on user_settings for all using (user_id = auth.uid() and is_org_member(org_id))
  with check (user_id = auth.uid() and is_org_member(org_id));
create policy user_memory_rw on user_memory for all using (user_id = auth.uid() and is_org_member(org_id))
  with check (user_id = auth.uid() and is_org_member(org_id));
create policy org_memory_rw on org_memory for all using (is_org_member(org_id)) with check (is_org_member(org_id));
create policy repo_index_read on repo_index for select using (is_org_member(org_id));

create policy audit_read on audit_logs for select using (is_org_member(org_id));
-- audit_logs are inserted by the service role only (server-side, so the hash chain can't be forged by a client).
