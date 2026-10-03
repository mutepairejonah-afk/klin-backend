create table if not exists public.execution_jobs (
  id             uuid primary key default gen_random_uuid(),
  session_id     uuid not null unique references public.sessions(id) on delete cascade,
  org_id         uuid not null references public.orgs(id) on delete cascade,
  goal           text not null,
  repo           text,
  branch         text,
  model_override jsonb,
  status         text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  attempts       integer not null default 0 check (attempts >= 0),
  worker_id      text,
  error         text,
  available_at   timestamptz not null default now(),
  started_at     timestamptz,
  heartbeat_at   timestamptz,
  finished_at    timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists execution_jobs_claim_idx
  on public.execution_jobs (status, available_at, created_at);
create index if not exists execution_jobs_org_idx
  on public.execution_jobs (org_id, created_at desc);

alter table public.execution_jobs enable row level security;

create or replace function public.claim_execution_job(p_worker_id text)
returns setof public.execution_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with candidate as (
    select id
    from public.execution_jobs
    where status = 'queued' and available_at <= now()
    order by created_at
    for update skip locked
    limit 1
  )
  update public.execution_jobs j
  set status = 'running', worker_id = p_worker_id, attempts = j.attempts + 1,
      started_at = coalesce(j.started_at, now()), heartbeat_at = now(), updated_at = now()
  from candidate
  where j.id = candidate.id
  returning j.*;
end;
$$;

create or replace function public.requeue_stale_execution_jobs(p_timeout_seconds integer default 900)
returns integer
language sql
security definer
set search_path = public
as $$
  with stale as (
    update public.execution_jobs
    set status = 'queued', worker_id = null, available_at = now(), updated_at = now(),
        error = coalesce(error || E'\n', '') || 'worker heartbeat expired; requeued'
    where status = 'running'
      and heartbeat_at < now() - make_interval(secs => greatest(p_timeout_seconds, 60))
      and attempts < 3
    returning id
  ) select count(*)::integer from stale;
$$;

revoke all on function public.claim_execution_job(text) from public;
revoke all on function public.requeue_stale_execution_jobs(integer) from public;
grant execute on function public.claim_execution_job(text) to service_role;
grant execute on function public.requeue_stale_execution_jobs(integer) to service_role;
