-- Broadcast row changes to subscribed clients. RLS still applies.
do $$
declare t text;
begin
  foreach t in array array['sessions','events','approvals','artifacts','sandboxes']
  loop
    if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename=t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
alter table public.sessions  replica identity full;
alter table public.approvals replica identity full;
