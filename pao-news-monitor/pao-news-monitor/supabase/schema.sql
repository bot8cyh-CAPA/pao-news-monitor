-- PAO News Monitor database.
-- Paste this whole file into Supabase > SQL Editor > New query, then press Run.
-- Safe to run again: it only creates what's missing.

create table if not exists paos (
  id           text primary key,
  grp          text,               -- Member / Associate / Affiliate / Stakeholder / Inbox
  jurisdiction text,
  name         text not null,
  abbr         text,
  website      text,
  active       boolean default true,
  notes        text,
  sort_order   int default 0
);

create table if not exists items (
  id            text primary key,
  pao_id        text not null references paos(id),
  source        text not null check (source in ('website','google_news','newsapi','email','manual')),
  title         text not null,
  url           text,
  published_at  timestamptz,
  snippet       text,
  content       text,
  source_name   text,
  language      text,
  is_baseline   boolean default false,      -- first scan of a site: hidden by default
  first_seen_at timestamptz default now(),
  -- filled in by your team on the web page:
  relevance     text check (relevance in ('relevant','not_relevant')),
  category      text,
  notes         text,
  reviewed_by   text,
  reviewed_at   timestamptz
);
create index if not exists items_pao_seen on items (pao_id, first_seen_at desc);
create index if not exists items_seen on items (first_seen_at desc);

create table if not exists source_health (
  pao_id               text not null,
  source               text not null,
  status               text,     -- ok / warning / error / skipped
  message              text,
  last_run_at          timestamptz,
  last_success_at      timestamptz,
  last_new_at          timestamptz,
  items_found          int,
  items_new            int,
  consecutive_failures int default 0,
  primary key (pao_id, source)
);

create table if not exists runs (
  id          bigserial primary key,
  started_at  timestamptz,
  finished_at timestamptz,
  summary     jsonb
);

-- ---------- security ----------
-- Only signed-in team members can read. They can tag items and add manual
-- items (e.g. something spotted on LinkedIn). Only the collector (service key)
-- can add collected items. Nobody can delete through the web page.
alter table paos          enable row level security;
alter table items         enable row level security;
alter table source_health enable row level security;
alter table runs          enable row level security;

drop policy if exists "team reads paos" on paos;
create policy "team reads paos" on paos for select to authenticated using (true);
drop policy if exists "team reads items" on items;
create policy "team reads items" on items for select to authenticated using (true);
drop policy if exists "team reads health" on source_health;
create policy "team reads health" on source_health for select to authenticated using (true);
drop policy if exists "team reads runs" on runs;
create policy "team reads runs" on runs for select to authenticated using (true);

drop policy if exists "team tags items" on items;
create policy "team tags items" on items for update to authenticated using (true) with check (true);
drop policy if exists "team adds manual items" on items;
create policy "team adds manual items" on items for insert to authenticated with check (source = 'manual');

-- the web page may only change the tagging columns
revoke update on items from authenticated, anon;
grant update (relevance, category, notes, reviewed_by, reviewed_at) on items to authenticated;
revoke all on paos, items, source_health, runs from anon;
