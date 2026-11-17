-- GrantKeep Phase 4: deadline engine, email reminder settings, calendar feed.
-- Paste this whole file into Supabase > SQL Editor > New query > Run.
-- Safe to run more than once.

-- ---------- new columns ----------
alter table public.grants
  add column if not exists report_due_days int not null default 30
  check (report_due_days between 0 and 365);

alter table public.deadlines add column if not exists title text;
alter table public.deadlines add column if not exists notes text;
alter table public.deadlines add column if not exists auto boolean not null default false;   -- made by the schedule
alter table public.deadlines add column if not exists reminders_sent int[] not null default '{}'; -- 30/14/7/1 already emailed

alter table public.members add column if not exists email_reminders boolean not null default true;

-- private calendar link (each organization gets its own secret code)
alter table public.organizations
  add column if not exists calendar_token text unique default encode(gen_random_bytes(18), 'hex');

create index if not exists deadlines_open_due on public.deadlines (status, due_date);

-- ---------- deadline engine ----------
-- Makes the report due dates for one grant from its schedule.
-- Keeps deadlines people added by hand and ones already marked submitted.
create or replace function public.generate_deadlines(p_grant uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  g        public.grants;
  step     interval;
  label    text;
  label2   text;
  k        int := 1;
  p_end    date;
  due      date;
begin
  select * into g from public.grants where id = p_grant;
  if not found then return; end if;

  delete from public.deadlines where grant_id = p_grant and auto and status = 'open';

  if g.start_date is null or g.end_date is null
     or g.status not in ('awarded', 'active') or g.report_frequency = 'none' then
    return;
  end if;

  step := case g.report_frequency
    when 'monthly' then interval '1 month' when 'quarterly' then interval '3 months'
    when 'semiannual' then interval '6 months' when 'annual' then interval '1 year' end;
  label := case g.report_frequency
    when 'monthly' then 'Monthly report' when 'quarterly' then 'Quarterly report'
    when 'semiannual' then '6-month report' when 'annual' then 'Yearly report' end;

  -- interim reports: due N days after each period ends (the last period is the final report)
  if step is not null then
    loop
      p_end := (g.start_date + step * k)::date - 1;
      exit when p_end >= g.end_date or k > 400;
      due := p_end + g.report_due_days;
      label2 := label || ' (period ending ' || to_char(p_end, 'Mon FMDD, YYYY') || ')';
      -- skip ones already submitted, and old ones more than 30 days past (likely done before GrantKeep)
      if due >= current_date - 30 and not exists
         (select 1 from public.deadlines d where d.grant_id = p_grant and d.auto and d.title = label2) then
        insert into public.deadlines (org_id, grant_id, type, due_date, title, auto)
        values (g.org_id, g.id, 'narrative', due, label2, true);
      end if;
      k := k + 1;
    end loop;
  end if;

  -- final report
  due := g.end_date + g.report_due_days;
  if due >= current_date - 30 and not exists
     (select 1 from public.deadlines d where d.grant_id = p_grant and d.auto and d.title = 'Final report') then
    insert into public.deadlines (org_id, grant_id, type, due_date, title, auto)
    values (g.org_id, g.id, 'narrative', due, 'Final report', true);
  end if;
end $$;

revoke execute on function public.generate_deadlines(uuid) from public, anon, authenticated;

create or replace function public.grants_make_deadlines()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.generate_deadlines(new.id);
  return null;
end $$;

drop trigger if exists grants_deadlines on public.grants;
create trigger grants_deadlines
  after insert or update of start_date, end_date, report_frequency, report_due_days, status
  on public.grants for each row execute function public.grants_make_deadlines();

-- ---------- small helpers the app calls ----------
-- Anyone can turn their own reminder emails on or off.
create or replace function public.set_my_reminders(p_org uuid, p_on boolean)
returns void language sql security definer set search_path = public as $$
  update public.members set email_reminders = p_on where org_id = p_org and user_id = auth.uid();
$$;
revoke execute on function public.set_my_reminders(uuid, boolean) from public, anon;
grant  execute on function public.set_my_reminders(uuid, boolean) to authenticated;

-- Admins can make a new calendar link (the old one stops working).
create or replace function public.reset_calendar_token(p_org uuid)
returns text language plpgsql security definer set search_path = public as $$
declare t text;
begin
  if not public.has_role(p_org, array['admin']) then raise exception 'Only an Admin can do this'; end if;
  t := encode(gen_random_bytes(18), 'hex');
  update public.organizations set calendar_token = t where id = p_org;
  return t;
end $$;
revoke execute on function public.reset_calendar_token(uuid) from public, anon;
grant  execute on function public.reset_calendar_token(uuid) to authenticated;

-- ---------- make deadlines for grants you already have ----------
select public.generate_deadlines(id) from public.grants;
