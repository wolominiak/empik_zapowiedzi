-- Tabela propozycji zapowiedzi z Empiku (zasilana przez scraper empik-zapowiedzi)
-- Jesli tabela juz istnieje (tworzona wczesniej z panelu zaczytajsie) - nic sie nie stanie,
-- wszystko jest IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS public.empik_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empik_id text UNIQUE,            -- ID produktu z Empiku (do upsertu, bez duplikatow)
  title text NOT NULL,
  author text,
  cover_url text,
  ean text,
  release_date date,
  description text,
  category text,
  details_ok boolean DEFAULT false, -- czy scraper dociagnal komplet ze strony produktu
  status text NOT NULL DEFAULT 'new',  -- new / added / dismissed
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_empik_proposals_status ON public.empik_proposals(status);

-- RLS: scraper pisze service key (omija RLS), panel czyta i zmienia status jako zalogowany
ALTER TABLE public.empik_proposals ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "empik_proposals_read" ON public.empik_proposals
    FOR SELECT TO authenticated USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "empik_proposals_update_status" ON public.empik_proposals
    FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
