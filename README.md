# empik-zapowiedzi

Scraper zapowiedzi książkowych z Empiku dla panelu admina zaczytajsie.pl.
Działa na GitHub Actions 3x dziennie, wrzuca propozycje do tabeli `empik_proposals`
w Supabase, skąd panel admina pokazuje je w sekcji "Propozycje z Empiku".

## Jak działa

1. Pobiera listing `https://www.empik.com/zapowiedzi/ksiazki` (do 3 stron) i zbiera ID produktów.
2. Dla nowych pozycji (i tych bez kompletu danych) pobiera stronę produktu i wyciąga:
   tytuł, autora, okładkę, EAN, datę premiery, opis, kategorię.
   Źródła danych w kolejności: JSON-LD -> meta og:/product: -> regexy w treści.
   Budżet: max 50 stron produktów na przebieg (reszta uzupełni się w kolejnych - kolumna `details_ok`).
3. Zapis do Supabase:
   - nowe pozycje: INSERT ze `status='new'`
   - istniejące: UPDATE tylko szczegółów - status (`added`/`dismissed`) nigdy nie jest ruszany
   - zapowiedzi z datą premiery w przeszłości są pomijane

## Konfiguracja (jednorazowo)

1. **Supabase**: uruchom `sql/empik_proposals.sql` w SQL Editorze
   (jeśli tabela już istnieje - skrypt niczego nie zepsuje, wszystko jest IF NOT EXISTS).

2. **Nowe repo na GitHubie**: wgraj wszystkie pliki z tego folderu
   (`scraper.py`, `requirements.txt`, `.github/workflows/scraper.yml`, `sql/`, `README.md`).
   UWAGA: folder `.github` zaczyna się od kropki - upewnij się, że go wgrałeś
   (przy przeciąganiu w przeglądarce łatwo go pominąć, bo bywa ukryty w Eksploratorze).

3. **Sekrety**: w repo Settings -> Secrets and variables -> Actions -> New repository secret:
   - `SUPABASE_URL` = `https://auth.zaczytajsie.pl`
   - `SUPABASE_SERVICE_KEY` = klucz **service_role** z Supabase
     (Dashboard -> Settings -> API -> service_role; NIE anon! Service key omija RLS
     i pozwala scraperowi pisać do tabeli)

4. **Pierwsze uruchomienie ręczne**: zakładka Actions -> "Empik zapowiedzi scraper"
   -> Run workflow. Obejrzyj logi kroku "Scraper" - każdy pobrany produkt jest tam wypisany.

Potem działa samo: cron 3x dziennie (12:43, 17:43, 22:43 czasu polskiego letniego).

## Rozwiązywanie problemów

**W logach same "HTTP 403" / "Listing pusty"**
Empik zablokował zapytanie. Scraper wysyła przeglądarkowe nagłówki, co zwykle wystarcza,
ale IP GitHuba bywają czasowo blokowane. Odczekaj i uruchom ręcznie ponownie.
Jeśli 403 jest trwałe - trzeba będzie przenieść uruchamianie na inny host (np. własny komputer
przez crona albo tani VPS) - sam skrypt zadziała wszędzie, wystarczą te same zmienne środowiskowe.

**"BRAK SEKRETOW"**
Sekrety nie są ustawione albo mają inne nazwy - muszą być dokładnie
`SUPABASE_URL` i `SUPABASE_SERVICE_KEY` (Settings repo, nie środowiska).

**"INSERT blad 401/403"**
Podany klucz to anon zamiast service_role, albo URL Supabase jest błędny.

**Workflow w ogóle się nie uruchamia**
- Sprawdź, czy plik jest dokładnie w `.github/workflows/scraper.yml` (literówka w ścieżce = GitHub go nie widzi).
- Harmonogramy cron na GitHubie bywają opóźnione o kilkanaście minut - to normalne.
- Na darmowym planie GitHub wyłącza crony w repo bez aktywności po 60 dniach - wystarczy
  wejść w Actions i kliknąć "Enable" albo zrobić dowolny commit.

**Propozycje nie pojawiają się w panelu**
Sprawdź w Supabase: `SELECT count(*), status FROM empik_proposals GROUP BY status;`
Jeśli wiersze są, a panel ich nie widzi - problem jest po stronie panelu (RLS/logowanie),
nie scrapera.

## Dostrajanie

W `scraper.py` na górze:
- `LISTING_PAGES` / `LISTING_STEP` - ile stron listingu przeglądać
- `DETAILS_BUDGET` - ile stron produktów na przebieg
- `EXCLUDED_CATEGORIES` - kategorie Empiku do pominięcia, np. `["Komiks"]`
- `REQUEST_DELAY` - odstęp między zapytaniami (nie schodź poniżej 1s)
