-- GrantKeep database schema (Phase 1 + 2)
-- Paste this whole file into Supabase > SQL Editor > New query > Run.
-- Safe to run on a fresh project. Every table carries org_id and has
-- row-level security, so an organization can only ever see its own rows.

create extension if not exists pgcrypto;

-- ============================================================
-- TABLES
-- ============================================================

create table public.organizations (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  ein               text,
  fiscal_year_start int  not null default 1 check (fiscal_year_start between 1 and 12),
  plan              text not null default 'free' check (plan in ('free','small_org','consultant')),
  created_at        timestamptz not null default now()
);

create table public.members (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organizations(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       text not null check (role in ('admin','finance','program')),
  email      text,
  created_at timestamptz not null default now(),
  unique (org_id, user_id)
);

create table public.funders (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organizations(id) on delete cascade,
  name       text not null,
  type       text not null default 'foundation'
             check (type in ('foundation','state','federal','corporate','local')),
  contact    text,
  notes      text,
  created_at timestamptz not null default now(),
  unique (id, org_id)
);

create table public.grants (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations(id) on delete cascade,
  funder_id        uuid,
  title            text not null,
  amount_awarded   numeric(14,2) not null default 0 check (amount_awarded >= 0),
  start_date       date,
  end_date         date,
  status           text not null default 'prospect'
                   check (status in ('prospect','applied','awarded','active','closed')),
  restricted       boolean not null default true,
  indirect_rate    numeric(5,2) check (indirect_rate is null or (indirect_rate >= 0 and indirect_rate <= 100)),
  report_frequency text not null default 'none'
                   check (report_frequency in ('none','monthly','quarterly','semiannual','annual','final_only')),
  allowed_costs    text,
  notes            text,
  owner_member_id  uuid references public.members(id) on delete set null,
  created_at       timestamptz not null default now(),
  unique (id, org_id),
  foreign key (funder_id, org_id) references public.funders(id, org_id) on delete set null (funder_id),
  check (end_date is null or start_date is null or end_date >= start_date)
);

create table public.budget_lines (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations(id) on delete cascade,
  grant_id        uuid not null,
  name            text not null,
  approved_amount numeric(14,2) not null default 0 check (approved_amount >= 0),
  is_salary       boolean not null default false,
  created_at      timestamptz not null default now(),
  unique (id, grant_id),
  foreign key (grant_id, org_id) references public.grants(id, org_id) on delete cascade
);

create table public.documents (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  grant_id    uuid,
  funder_id   uuid,
  file_path   text not null,
  kind        text not null default 'other'
              check (kind in ('award_letter','receipt','report','contract','other')),
  uploaded_by uuid references public.members(id) on delete set null,
  created_at  timestamptz not null default now(),
  foreign key (grant_id, org_id)  references public.grants(id, org_id)  on delete cascade,
  foreign key (funder_id, org_id) references public.funders(id, org_id) on delete set null (funder_id)
);

create table public.expenses (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations(id) on delete cascade,
  grant_id       uuid not null,
  budget_line_id uuid,
  date           date not null default current_date,
  vendor         text,
  amount         numeric(14,2) not null,
  memo           text,
  source         text not null default 'manual' check (source in ('manual','csv')),
  receipt_doc_id uuid references public.documents(id) on delete set null,
  created_at     timestamptz not null default now(),
  foreign key (grant_id, org_id)         references public.grants(id, org_id) on delete cascade,
  -- the budget line must belong to the same grant (can't delete a line that still has expenses)
  foreign key (budget_line_id, grant_id) references public.budget_lines(id, grant_id)
);

create table public.deadlines (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations(id) on delete cascade,
  grant_id         uuid not null,
  type             text not null check (type in ('narrative','financial','renewal','draw','other')),
  due_date         date not null,
  status           text not null default 'open' check (status in ('open','submitted','late')),
  reminder_sent_at timestamptz,
  created_at       timestamptz not null default now(),
  foreign key (grant_id, org_id) references public.grants(id, org_id) on delete cascade
);

create table public.report_exports (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id) on delete cascade,
  grant_id     uuid not null,
  period_start date not null,
  period_end   date not null,
  file_path    text,
  created_at   timestamptz not null default now(),
  foreign key (grant_id, org_id) references public.grants(id, org_id) on delete cascade
);

create table public.csv_mappings (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  source_name text not null,
  column_map  jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  unique (org_id, source_name)
);

create table public.activity_log (
  id         bigint generated always as identity primary key,
  org_id     uuid not null references public.organizations(id) on delete cascade,
  member_id  uuid references public.members(id) on delete set null,
  action     text not null,
  target     text not null,
  details    text,
  created_at timestamptz not null default now()
);

create index on public.members (user_id);
create index on public.grants (org_id);
create index on public.budget_lines (grant_id);
create index on public.expenses (grant_id);
create index on public.expenses (org_id, date);
create index on public.deadlines (org_id, due_date);
create index on public.activity_log (org_id, created_at desc);

-- ============================================================
-- HELPER FUNCTIONS (used by the security rules)
-- ============================================================

create or replace function public.is_member(p_org uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.members where org_id = p_org and user_id = auth.uid());
$$;

create or replace function public.has_role(p_org uuid, p_roles text[])
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.members
                 where org_id = p_org and user_id = auth.uid() and role = any(p_roles));
$$;

create or replace function public.line_is_salary(p_line uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select is_salary from public.budget_lines where id = p_line), false);
$$;

-- Creates an organization and makes the signed-in user its Admin.
create or replace function public.create_organization(p_name text, p_ein text default null, p_fy_start int default 1)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_org uuid;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if length(trim(coalesce(p_name, ''))) = 0 then raise exception 'Organization name is required'; end if;
  insert into public.organizations (name, ein, fiscal_year_start)
    values (trim(p_name), nullif(trim(coalesce(p_ein, '')), ''), coalesce(p_fy_start, 1))
    returning id into v_org;
  insert into public.members (org_id, user_id, role, email)
    values (v_org, auth.uid(), 'admin', auth.jwt() ->> 'email');
  return v_org;
end $$;

revoke execute on function public.create_organization(text, text, int) from public, anon;
grant  execute on function public.create_organization(text, text, int) to authenticated;

-- ============================================================
-- ACTIVITY LOG (audit trail, written automatically — users can't fake it)
-- ============================================================

create or replace function public.log_activity()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_row    jsonb;
  v_org    uuid;
  v_member uuid;
begin
  v_row := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  v_org := (v_row ->> 'org_id')::uuid;
  if not exists (select 1 from public.organizations where id = v_org) then
    return null; -- organization itself is being deleted
  end if;
  select id into v_member from public.members where org_id = v_org and user_id = auth.uid();
  insert into public.activity_log (org_id, member_id, action, target, details)
  values (v_org, v_member, lower(tg_op), tg_table_name || ':' || (v_row ->> 'id'),
          coalesce(v_row ->> 'title', v_row ->> 'name', v_row ->> 'vendor', v_row ->> 'email')
            || coalesce(' $' || (v_row ->> 'amount'), ''));
  return null;
end $$;

do $$
declare t text;
begin
  foreach t in array array['members','funders','grants','budget_lines','expenses','deadlines','documents']
  loop
    execute format('create trigger %I_activity after insert or update or delete on public.%I
                    for each row execute function public.log_activity()', t, t);
  end loop;
end $$;

-- ============================================================
-- ROW-LEVEL SECURITY
-- Roles: admin = everything; finance = edit grants & money;
--        program = read-only, and can't see salary lines; can add non-salary expenses.
-- ============================================================

alter table public.organizations  enable row level security;
alter table public.members        enable row level security;
alter table public.funders        enable row level security;
alter table public.grants         enable row level security;
alter table public.budget_lines   enable row level security;
alter table public.expenses       enable row level security;
alter table public.deadlines      enable row level security;
alter table public.documents      enable row level security;
alter table public.report_exports enable row level security;
alter table public.csv_mappings   enable row level security;
alter table public.activity_log   enable row level security;

-- organizations: members read; admins edit name/EIN/fiscal year only (not plan)
create policy org_select on public.organizations for select using (public.is_member(id));
create policy org_update on public.organizations for update
  using (public.has_role(id, array['admin'])) with check (public.has_role(id, array['admin']));
revoke update on public.organizations from authenticated, anon;
grant  update (name, ein, fiscal_year_start) on public.organizations to authenticated;

-- members: everyone in the org can see the team; only admins change it
create policy members_select on public.members for select using (public.is_member(org_id));
create policy members_insert on public.members for insert with check (public.has_role(org_id, array['admin']));
create policy members_update on public.members for update
  using (public.has_role(org_id, array['admin'])) with check (public.has_role(org_id, array['admin']));
create policy members_delete on public.members for delete using (public.has_role(org_id, array['admin']));

-- simple tables: members read, admin/finance write
do $$
declare t text;
begin
  foreach t in array array['funders','grants','deadlines','documents','report_exports','csv_mappings']
  loop
    execute format('create policy %I_select on public.%I for select using (public.is_member(org_id))', t, t);
    execute format('create policy %I_insert on public.%I for insert with check (public.has_role(org_id, array[''admin'',''finance'']))', t, t);
    execute format('create policy %I_update on public.%I for update using (public.has_role(org_id, array[''admin'',''finance''])) with check (public.has_role(org_id, array[''admin'',''finance'']))', t, t);
    execute format('create policy %I_delete on public.%I for delete using (public.has_role(org_id, array[''admin'',''finance'']))', t, t);
  end loop;
end $$;

-- budget lines: program staff never see salary lines
create policy budget_lines_select on public.budget_lines for select using (
  public.is_member(org_id) and (not is_salary or public.has_role(org_id, array['admin','finance'])));
create policy budget_lines_insert on public.budget_lines for insert
  with check (public.has_role(org_id, array['admin','finance']));
create policy budget_lines_update on public.budget_lines for update
  using (public.has_role(org_id, array['admin','finance'])) with check (public.has_role(org_id, array['admin','finance']));
create policy budget_lines_delete on public.budget_lines for delete
  using (public.has_role(org_id, array['admin','finance']));

-- expenses: program staff don't see expenses on salary lines; they may add non-salary expenses
create policy expenses_select on public.expenses for select using (
  public.is_member(org_id) and (
    public.has_role(org_id, array['admin','finance'])
    or budget_line_id is null
    or not public.line_is_salary(budget_line_id)));
create policy expenses_insert on public.expenses for insert with check (
  public.has_role(org_id, array['admin','finance'])
  or (public.has_role(org_id, array['program'])
      and (budget_line_id is null or not public.line_is_salary(budget_line_id))));
create policy expenses_update on public.expenses for update
  using (public.has_role(org_id, array['admin','finance'])) with check (public.has_role(org_id, array['admin','finance']));
create policy expenses_delete on public.expenses for delete
  using (public.has_role(org_id, array['admin','finance']));

-- activity log: admins read; nobody writes directly (triggers do it)
create policy activity_select on public.activity_log for select using (public.has_role(org_id, array['admin']));
