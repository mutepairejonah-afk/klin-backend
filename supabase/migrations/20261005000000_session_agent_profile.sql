-- Keep the selected specialist available for chat and coding follow-ups.
-- Prompts are supplied by the client catalog and contain no provider secrets.
alter table sessions
  add column if not exists agent_profile jsonb;
