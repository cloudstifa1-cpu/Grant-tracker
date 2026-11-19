-- GrantKeep Phase 6: documents, team invites + roles, activity log.
-- Run once in Supabase: SQL Editor -> New query -> paste -> Run. Safe to run again.

-- ---------- Documents: keep the file's name and size ----------
alter table public.documents add column if not exists name text;
alter table public.documents add column if not exists size_bytes bigint;

-- ---------- Private file storage (25 MB per file) ----------
insert into storage.buckets (id, name, public, file_size_limit)
values ('grant-docs', 'grant-docs', false, 26214400)
on conflict (id) do update set public = false, file_size_limit = 26214400;

-- Files live at <org id>/<grant id>/<file>. These check the first folder safely.
create or replace function public.member_of_folder(p_name text, p_roles text[] default null)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare v_org uuid;
begin
  begin v_org := split_part(p_name, '/', 1)::uuid; exception when others then return false; end;
  if p_roles is null then return public.is_member(v_org); end if;
  return public.has_role(v_org, p_roles);
end $$;

drop policy if exists gk_docs_read   on storage.objects;
drop policy if exists gk_docs_add    on storage.objects;
drop policy if exists gk_docs_remove on storage.objects;
create policy gk_docs_read on storage.objects for select to authenticated
  using (bucket_id = 'grant-docs' and public.member_of_folder(name));
create policy gk_docs_add on storage.objects for insert to authenticated
  with check (bucket_id = 'grant-docs' and public.member_of_folder(name, array['admin','finance']));
create policy gk_docs_remove on storage.objects for delete to authenticated
  using (bucket_id = 'grant-docs' and public.member_of_folder(name, array['admin','finance']));

-- ---------- Team invites ----------
create table if not exists public.invites (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organizations(id) on delete cascade,
  email      text not null check (email = lower(trim(email)) and email like '%@%'),
  role       text not null check (role in ('admin','finance','program')),
  created_at timestamptz not null default now(),
  unique (org_id, email)
);
alter table public.invites enable row level security;
drop policy if exists invites_select on public.invites;
drop policy if exists invites_insert on public.invites;
drop policy if exists invites_delete on public.invites;
create policy invites_select on public.invites for select using (public.has_role(org_id, array['admin']));
create policy invites_insert on public.invites for insert with check (public.has_role(org_id, array['admin']));
create policy invites_delete on public.invites for delete using (public.has_role(org_id, array['admin']));

-- When an invited person signs in with that email, add them to the team.
create or replace function public.accept_invites()
returns int language plpgsql security definer set search_path = public as $$
declare v_email text := lower(auth.jwt() ->> 'email'); n int;
begin
  if auth.uid() is null or v_email is null then return 0; end if;
  insert into public.members (org_id, user_id, role, email)
    select org_id, auth.uid(), role, v_email from public.invites where email = v_email
    on conflict (org_id, user_id) do nothing;
  get diagnostics n = row_count;
  delete from public.invites where email = v_email;
  return n;
end $$;
revoke execute on function public.accept_invites() from public, anon;
grant  execute on function public.accept_invites() to authenticated;

-- Admins may change only a teammate's role (not move people between organizations).
revoke update on public.members from authenticated, anon;
grant  update (role) on public.members to authenticated;

-- Never leave an organization without an Admin.
create or replace function public.keep_one_admin()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.role <> 'admin' then return coalesce(new, old); end if;
  if tg_op = 'UPDATE' and new.role = 'admin' then return new; end if;
  if not exists (select 1 from public.organizations where id = old.org_id) then return coalesce(new, old); end if;
  if not exists (select 1 from public.members where org_id = old.org_id and role = 'admin' and id <> old.id) then
    raise exception 'The team needs at least one Admin. Make someone else Admin first.';
  end if;
  return coalesce(new, old);
end $$;
drop trigger if exists members_keep_admin on public.members;
create trigger members_keep_admin before update or delete on public.members
  for each row execute function public.keep_one_admin();
