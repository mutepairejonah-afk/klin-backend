-- Apply after the existing core schema.
-- Events are replayed by (session_id, seq); without this constraint concurrent
-- emitters can publish duplicate positions and corrupt replay state.
create unique index if not exists events_session_seq_unique
  on public.events (session_id, seq);

-- Approval org scoping and its index are added in 0003_approval_org_scope.sql,
-- after the column has been backfilled from sessions.
