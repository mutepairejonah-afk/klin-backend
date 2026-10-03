-- Approval rows are owned by a session, but explicit org scope is required by
-- the API and executor gate so a compromised session identifier cannot cross
-- organization boundaries.
alter table public.approvals add column if not exists org_id uuid;

update public.approvals a
set org_id = s.org_id
from public.sessions s
where s.id = a.session_id and a.org_id is null;

alter table public.approvals alter column org_id set not null;
alter table public.approvals
  add constraint approvals_org_fk foreign key (org_id) references public.orgs(id) on delete cascade;

create index if not exists approvals_org_session_status_idx
  on public.approvals (org_id, session_id, status);
