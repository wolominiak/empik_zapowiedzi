-- Tabela propozycji książek z zapowiedzi Empiku (dla panelu admina zaczytajsie)
-- Uruchom w Supabase: SQL Editor → New query → wklej → Run

create table if not exists empik_proposals (
  id            text primary key,              -- ID produktu Empiku, np. "p1584921703"
  title         text not null,
  author        text,
  cover_url     text,
  ean           text,
  release_date  date,
  description   text,
  category      text,
  url           text not null,                 -- link do strony produktu na Empiku
  status        text not null default 'new',   -- 'new' | 'added' | 'dismissed'
  details_ok    boolean not null default false,-- czy udało się pobrać komplet danych
  first_seen    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists empik_proposals_status_idx
  on empik_proposals (status, first_seen desc);

-- RLS: scraper pisze kluczem service_role (omija RLS).
-- Panel admina czyta i zmienia status — poniższe polityki są dla zalogowanych
-- użytkowników Supabase Auth. Jeśli Twój panel używa klucza anon bez logowania,
-- zamień "to authenticated" na "to anon" w obu politykach.

alter table empik_proposals enable row level security;

create policy "admin read proposals"
  on empik_proposals for select
  to authenticated
  using (true);

create policy "admin update proposals"
  on empik_proposals for update
  to authenticated
  using (true)
  with check (true);
