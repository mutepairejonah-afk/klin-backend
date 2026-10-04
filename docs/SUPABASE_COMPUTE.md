# Supabase configuration for heavy AI sandbox jobs

Supabase is the **control plane** for heavy jobs. It stores the durable queue,
lease ownership, heartbeats, status, resource policy, and result metadata. The
actual CPU/RAM-heavy work runs in the local Docker/OpenSandbox worker, not in a
Supabase Edge Function.

## Apply the database configuration

Apply migrations in order, including:

```text
0002_event_integrity.sql
0003_approval_org_scope.sql
0004_execution_jobs.sql
0005_execution_compute_config.sql
0006_clerk_invitations.sql
```

Using the Supabase CLI:

```bash
supabase link --project-ref <project-ref>
supabase db push
```

Or run the migration SQL in the Supabase SQL Editor. Verify the following exist:

- `public.execution_jobs`
- `public.claim_execution_job(text, integer)`
- `public.heartbeat_execution_job(uuid, text, integer)`
- `public.finish_execution_job(uuid, text, text, text, jsonb)`
- `public.requeue_stale_execution_jobs(integer)`

Only the `service_role` can execute the worker RPCs. Never put the service-role
key in the browser or in a sandbox container.

`0006_clerk_invitations.sql` stores pending Clerk invitations. When an invited
user signs in for the first time, the Clerk-verified middleware matches the
lowercase email and creates the organization membership. This avoids calling
Supabase Auth APIs in a Clerk-authenticated deployment.

## Queue policy

Each job has:

- `priority`: 0–1000; higher values are claimed first.
- `max_attempts`: 1–10; default 3.
- `resource_profile`: JSON policy stored with the job.
- `lease_expires_at`: worker lease deadline.
- `heartbeat_at`: liveness timestamp.
- `result`: terminal result metadata, not large files.

Large logs, patches, screenshots, and build artifacts belong in Supabase
Storage, with only object paths or signed-download metadata in `result`.

A worker claims a queued job atomically. The claim sets `worker_id`, increments
`attempts`, and creates a lease. Heartbeats extend the lease only when the same
worker owns the job. Completion is also worker-owned, preventing a stale worker
from overwriting a newer attempt.

## Worker environment

For the local Compose worker, set these server-only variables in `.env`:

```env
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
KILN_EXECUTION_ENABLED=true
ORCHESTRATOR_MODE=coding
KILN_WORKER_POLL_MS=2000
KILN_WORKER_LEASE_SECONDS=900
KILN_WORKER_STALE_SECONDS=900
KILN_SANDBOX_IMAGE=klin-sandbox:local
KILN_SANDBOX_NETWORK=none
KILN_SANDBOX_CPUS=2
KILN_SANDBOX_MEMORY=2g
KILN_SANDBOX_PIDS_LIMIT=256
```

Start it locally:

```bash
docker compose build sandbox-image worker
docker compose up -d worker
docker compose logs -f worker
```

The worker must mount `/var/run/docker.sock` to launch sibling sandbox
containers. This is appropriate only for a trusted local machine; Docker socket
access is effectively root access to that machine.

## Operational checks

Useful SQL checks in the Supabase dashboard:

```sql
select status, count(*)
from public.execution_jobs
group by status
order by status;

select id, session_id, status, attempts, worker_id,
       heartbeat_at, lease_expires_at, created_at
from public.execution_jobs
where status in ('queued', 'running')
order by priority desc, created_at;
```

If a worker is killed, the next worker invocation calls
`requeue_stale_execution_jobs(900)`. Jobs below their attempt limit return to
`queued`; jobs at the limit become `failed` instead of running forever.

## What not to configure

Do not put Docker execution, repository builds, model servers, or long-running
agent loops inside Supabase Edge Functions. Edge Functions should be reserved
for short control-plane operations such as creating a job, issuing a signed
artifact URL, or receiving a worker webhook. They are not the heavy-compute
worker host.
