-- GrantKeep Phase 5: report history.
-- Saves each report's dates and variance notes so they're filled in next time.
-- Run once in Supabase: SQL Editor -> New query -> paste -> Run.
alter table public.report_exports add column if not exists file_type text
  check (file_type is null or file_type in ('pdf','docx','xlsx'));
alter table public.report_exports add column if not exists notes jsonb not null default '{}'::jsonb;
create index if not exists report_exports_grant_idx on public.report_exports (grant_id, created_at desc);
