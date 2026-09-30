-- connections.meta held a bare string before; the real GitHub OAuth flow
-- stores structured profile info ({login, avatarUrl}) on connect.
alter table connections alter column meta type jsonb using case when meta is null or meta = '' then null else to_jsonb(meta) end;
