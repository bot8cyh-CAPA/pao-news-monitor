-- PAO News Monitor - update 2: item types (news / events / publications),
-- leadership & contact page watch, Facebook button.
-- Paste this whole file into Supabase > SQL Editor > New query, then press Run.
-- Safe to run more than once. It only adds things; nothing is deleted.

-- item type: news / events / publications / leadership / contact
alter table items add column if not exists kind text;
create index if not exists items_kind on items (kind);

-- allow the new "page_watch" source
alter table items drop constraint if exists items_source_check;
alter table items add constraint items_source_check
  check (source in ('website','google_news','newsapi','email','manual','page_watch'));

-- PAO extras shown on the page
alter table paos add column if not exists facebook text;
alter table paos add column if not exists lang text;

-- pages the collector keeps track of: listing pages it scans, and the
-- leadership / contact lines it watches for changes
create table if not exists watched_pages (
  pao_id          text not null,
  url             text not null,
  kind            text not null,     -- listing:news / listing:events / listing:publications / leadership / contact
  snapshot        text,              -- the watched lines last time (leadership / contact only)
  status          text,
  message         text,
  first_seen_at   timestamptz,
  last_checked_at timestamptz,
  last_changed_at timestamptz,
  primary key (pao_id, url, kind)
);
alter table watched_pages enable row level security;
drop policy if exists "team reads watched pages" on watched_pages;
create policy "team reads watched pages" on watched_pages for select to authenticated using (true);
revoke all on watched_pages from anon;

-- the team may correct an item's type on the web page
grant update (relevance, category, notes, reviewed_by, reviewed_at, kind) on items to authenticated;
