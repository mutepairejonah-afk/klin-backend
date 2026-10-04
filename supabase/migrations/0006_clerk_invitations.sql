create table if not exists public.org_invitations (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references public.orgs(id) on delete cascade,
  clerk_invitation_id  text not null unique,
  email                text not null,
  role                 text not null default 'viewer' check (role in ('owner', 'operator', 'viewer')),
  status               text not null default 'pending' check (status in ('pending', 'accepted', 'revoked')),
  created_at           timestamptz not null default now(),
  accepted_at          timestamptz
);

create unique index if not exists org_invitations_pending_email_idx
  on public.org_invitations (org_id, lower(email))
  where status = 'pending';
create index if not exists org_invitations_email_idx
  on public.org_invitations (lower(email), status);

alter table public.org_invitations enable row level security;
