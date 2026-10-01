-- Apply after the existing core schema.
-- Events are replayed by (session_id, seq); without this constraint concurrent
-- emitters can publish duplicate positions and corrupt replay state.
create unique index if not exists events_session_seq_unique
  on public.events (session_id, seq);

create index if not exists approvals_org_session_status_idx
  on public.approvals (org_id, session_id, status);

-- The API also scopes every query by org_id. Keep the database index aligned
-- with that invariant so approval resolution remains cheap and auditable.
