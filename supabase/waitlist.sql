-- Waitlist signups + visit counter for the landing page (public/waitlist.html).
-- Visitors can only ADD a signup; nobody can read the list from the website.
create table if not exists public.waitlist (
  id          bigint generated always as identity primary key,
  email       text not null check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' and length(email) <= 254),
  org_name    text check (length(org_name) <= 200),
  budget_size text check (budget_size in ('under_250k','250k_1m','1m_2m','over_2m')),
  current_tool text check (current_tool in ('spreadsheet','granthub','other_tool','nothing')),
  source      text check (length(source) <= 100),
  created_at  timestamptz not null default now()
);
create unique index if not exists waitlist_email_unique on public.waitlist (lower(email));
alter table public.waitlist enable row level security;
drop policy if exists waitlist_insert on public.waitlist;
create policy waitlist_insert on public.waitlist for insert to anon, authenticated with check (true);
revoke select, update, delete on public.waitlist from anon, authenticated;
grant insert on public.waitlist to anon, authenticated;

create table if not exists public.waitlist_visits (
  day    date primary key,
  visits int not null default 0
);
alter table public.waitlist_visits enable row level security;
revoke all on public.waitlist_visits from anon, authenticated;

create or replace function public.count_waitlist_visit()
returns void language sql security definer set search_path = public as $$
  insert into public.waitlist_visits (day, visits) values (current_date, 1)
  on conflict (day) do update set visits = waitlist_visits.visits + 1;
$$;
grant execute on function public.count_waitlist_visit() to anon, authenticated;
