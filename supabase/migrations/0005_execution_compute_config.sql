-- Heavy-compute queue policy. Supabase stores coordination metadata only;
-- Docker/OpenSandbox execution remains on the external worker host.
alter table public.execution_jobs
  add column if not exists priority integer not null default 100,
  add column if not exists max_attempts integer not null default 3,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists resource_profile jsonb not null default '{"cpus":2,"memory":"2g","pidsLimit":256,"network":"none"}'::jsonb,
  add column if not exists result jsonb;

alter table public.execution_jobs
  drop constraint if exists execution_jobs_priority_check;
alter table public.execution_jobs
  add constraint execution_jobs_priority_check check (priority between 0 and 1000);
alter table public.execution_jobs
  drop constraint if exists execution_jobs_attempts_limit_check;
alter table public.execution_jobs
  add constraint execution_jobs_attempts_limit_check check (max_attempts between 1 and 10);

create index if not exists execution_jobs_priority_claim_idx
  on public.execution_jobs (status, priority desc, available_at, created_at);
create index if not exists execution_jobs_lease_idx
  on public.execution_jobs (status, lease_expires_at)
  where status = 'running';

create or replace function public.claim_execution_job(
  p_worker_id text,
  p_lease_seconds integer default 900
)
returns setof public.execution_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_worker_id is null or length(trim(p_worker_id)) < 3 then
    raise exception 'worker id is required';
  end if;
  return query
  with candidate as (
    select id
    from public.execution_jobs
    where status = 'queued'
      and available_at <= now()
      and attempts < max_attempts
    order by priority desc, created_at
    for update skip locked
    limit 1
  )
  update public.execution_jobs j
  set status = 'running', worker_id = p_worker_id,
      attempts = j.attempts + 1,
      started_at = coalesce(j.started_at, now()),
      heartbeat_at = now(),
      lease_expires_at = now() + make_interval(secs => greatest(p_lease_seconds, 60)),
      updated_at = now()
  from candidate
  where j.id = candidate.id
  returning j.*;
end;
$$;

create or replace function public.heartbeat_execution_job(
  p_job_id uuid,
  p_worker_id text,
  p_lease_seconds integer default 900
)
returns boolean
language sql
security definer
set search_path = public
as $$
  with touched as (
    update public.execution_jobs
    set heartbeat_at = now(),
        lease_expires_at = now() + make_interval(secs => greatest(p_lease_seconds, 60)),
        updated_at = now()
    where id = p_job_id and status = 'running' and worker_id = p_worker_id
    returning id
  ) select exists(select 1 from touched);
$$;

create or replace function public.finish_execution_job(
  p_job_id uuid,
  p_worker_id text,
  p_status text,
  p_error text default null,
  p_result jsonb default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_status not in ('succeeded', 'failed', 'cancelled') then
    raise exception 'invalid terminal execution status';
  end if;
  return (
    with touched as (
      update public.execution_jobs
      set status = p_status, error = p_error, result = p_result,
          finished_at = now(), heartbeat_at = now(), lease_expires_at = null,
          updated_at = now()
      where id = p_job_id and status = 'running' and worker_id = p_worker_id
      returning id
    ) select exists(select 1 from touched)
  );
end;
$$;

create or replace function public.requeue_stale_execution_jobs(p_timeout_seconds integer default 900)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  changed integer;
begin
  with requeued as (
    update public.execution_jobs
    set status = 'queued', worker_id = null, available_at = now(),
        lease_expires_at = null, updated_at = now(),
        error = coalesce(error || E'\n', '') || 'worker lease expired; requeued'
    where status = 'running'
      and (heartbeat_at < now() - make_interval(secs => greatest(p_timeout_seconds, 60))
           or lease_expires_at < now())
      and attempts < max_attempts
    returning id
  ) select count(*)::integer into changed from requeued;

  update public.execution_jobs
  set status = 'failed', finished_at = now(), lease_expires_at = null,
      updated_at = now(), error = coalesce(error || E'\n', '') || 'worker lease expired after maximum attempts'
  where status = 'running'
    and (heartbeat_at < now() - make_interval(secs => greatest(p_timeout_seconds, 60))
         or lease_expires_at < now())
    and attempts >= max_attempts;

  return changed;
end;
$$;

-- The previous migration created claim_execution_job(text). Remove that
-- overload so a one-argument caller cannot bypass the lease-aware function.
drop function if exists public.claim_execution_job(text);
revoke all on function public.claim_execution_job(text, integer) from public;
revoke all on function public.heartbeat_execution_job(uuid, text, integer) from public;
revoke all on function public.finish_execution_job(uuid, text, text, text, jsonb) from public;
revoke all on function public.requeue_stale_execution_jobs(integer) from public;
grant execute on function public.claim_execution_job(text, integer) to service_role;
grant execute on function public.heartbeat_execution_job(uuid, text, integer) to service_role;
grant execute on function public.finish_execution_job(uuid, text, text, text, jsonb) to service_role;
grant execute on function public.requeue_stale_execution_jobs(integer) to service_role;
