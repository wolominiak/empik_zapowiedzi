# -*- coding: utf-8 -*-
"""
empik-zapowiedzi - scraper zapowiedzi ksiazkowych Empiku dla panelu zaczytajsie.pl

Dziala tak:
1. Pobiera strony listingu https://www.empik.com/zapowiedzi/ksiazki i zbiera ID produktow.
2. Dla produktow nowych lub bez kompletu danych (details_ok=false) pobiera strone produktu
   i wyciaga: tytul, autora, okladke, EAN, date premiery, opis, kategorie.
   Zrodla: JSON-LD (glowne) + meta og:/product: (fallback) + regexy (ostateczny fallback).
   Budzet: max DETAILS_BUDGET stron produktow na jeden przebieg.
3. Zapisuje do tabeli empik_proposals w Supabase:
   - nowe pozycje: INSERT ze status='new'
   - istniejace bez kompletu: UPDATE szczegolow (NIE rusza statusu - added/dismissed zostaja)

Sekrety (GitHub Actions): SUPABASE_URL, SUPABASE_SERVICE_KEY
"""

import json
import os
import re
import sys
import time
from datetime import date, datetime

import requests

# ============ KONFIGURACJA ============
LISTING_URL = "https://www.empik.com/zapowiedzi/ksiazki"
LISTING_PAGES = 3          # ile stron listingu na przebieg (start=0,60,120)
LISTING_STEP = 60          # przesuniecie paginacji (?start=)
DETAILS_BUDGET = 50        # max stron produktow na przebieg (nowe + backfill)
REQUEST_DELAY = 1.5        # sekundy miedzy zadaniami (nie mecz serwera)
EXCLUDED_CATEGORIES = []   # np. ["Komiks"] - kategorie Empiku do pominiecia (puste = bierz wszystko)

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")

# Przegladarowe naglowki - Empik potrafi odrzucac "gole" klienty HTTP (403).
HEADERS = {
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "pl-PL,pl;q=0.9,en;q=0.8",
    "Referer": "https://www.empik.com/",
}

session = requests.Session()
session.headers.update(HEADERS)


def log(*args):
    print("[empik-zapowiedzi]", *args, flush=True)


def fetch(url):
    """Pobierz strone; zwroc HTML albo None. Loguje status - kluczowe przy debugowaniu 403."""
    try:
        r = session.get(url, timeout=30)
        if r.status_code != 200:
            log(f"HTTP {r.status_code} dla {url}")
            return None
        return r.text
    except requests.RequestException as e:
        log(f"Blad sieci dla {url}: {e}")
        return None


# ============ LISTING: zbieranie ID produktow ============

# Link produktu-ksiazki: https://www.empik.com/<slug>,p<ID>,ksiazka-p
RE_PRODUCT = re.compile(r'href="(https://www\.empik\.com/[^"]*?,p(\d+),ksiazka-p)[^"]*"')


def collect_listing_ids():
    """Zwraca dict {empik_id: url} z pierwszych LISTING_PAGES stron listingu."""
    found = {}
    for page in range(LISTING_PAGES):
        url = LISTING_URL if page == 0 else f"{LISTING_URL}?start={page * LISTING_STEP}"
        html = fetch(url)
        if not html:
            break
        before = len(found)
        for m in RE_PRODUCT.finditer(html):
            found.setdefault(m.group(2), m.group(1))
        log(f"listing strona {page + 1}: {len(found) - before} nowych linkow (razem {len(found)})")
        if len(found) == before and page > 0:
            break  # paginacja nie dziala albo koniec - nie brnij dalej
        time.sleep(REQUEST_DELAY)
    return found


# ============ STRONA PRODUKTU: szczegoly ============

RE_JSONLD = re.compile(r'<script[^>]*type="application/ld\+json"[^>]*>(.*?)</script>', re.DOTALL)
RE_OG = lambda prop: re.compile(r'<meta[^>]+property="og:' + prop + r'"[^>]+content="([^"]*)"')
RE_META_PRODUCT = lambda name: re.compile(r'<meta[^>]+property="product:' + name + r'"[^>]+content="([^"]*)"')
RE_DATE_PL = re.compile(r'premier[a-z]*[:\s]*(?:&nbsp;|\s)*(\d{2})\.(\d{2})\.(\d{4})', re.IGNORECASE)
RE_EAN_TXT = re.compile(r'(?:EAN|ISBN)\D{0,20}(\d{13})')
RE_H1 = re.compile(r'<h1[^>]*>(.*?)</h1>', re.DOTALL)
RE_TAGS = re.compile(r'<[^>]+>')


def strip_tags(s):
    return RE_TAGS.sub(' ', s or '').replace('&amp;', '&').replace('&quot;', '"').replace('&#39;', "'").strip()


def parse_jsonld_blocks(html):
    """Wyciagnij wszystkie bloki JSON-LD (lista dictow; obsluga list i @graph)."""
    out = []
    for m in RE_JSONLD.finditer(html):
        raw = m.group(1).strip()
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            continue
        items = data if isinstance(data, list) else data.get('@graph', [data]) if isinstance(data, dict) else []
        for it in items:
            if isinstance(it, dict):
                out.append(it)
    return out


def pl_date_to_iso(d, mth, y):
    try:
        return date(int(y), int(mth), int(d)).isoformat()
    except ValueError:
        return None


def parse_product(html):
    """Zwraca dict szczegolow. Kazde pole: JSON-LD -> meta -> regex. Brakujace = None."""
    det = {"title": None, "author": None, "cover_url": None, "ean": None,
           "release_date": None, "description": None, "category": None}

    # --- JSON-LD (typy Product / Book) ---
    for block in parse_jsonld_blocks(html):
        t = block.get("@type", "")
        types = t if isinstance(t, list) else [t]
        if not any(x in ("Product", "Book") for x in types):
            continue
        det["title"] = det["title"] or strip_tags(block.get("name") or "") or None
        # autor: string, dict albo lista dictow
        a = block.get("author")
        if a and not det["author"]:
            if isinstance(a, list):
                det["author"] = ", ".join(strip_tags(x.get("name", "") if isinstance(x, dict) else str(x)) for x in a) or None
            elif isinstance(a, dict):
                det["author"] = strip_tags(a.get("name", "")) or None
            else:
                det["author"] = strip_tags(str(a)) or None
        img = block.get("image")
        if img and not det["cover_url"]:
            det["cover_url"] = img[0] if isinstance(img, list) else (img.get("url") if isinstance(img, dict) else img)
        det["ean"] = det["ean"] or block.get("gtin13") or block.get("isbn") or None
        rd = block.get("releaseDate") or block.get("datePublished")
        if rd and not det["release_date"]:
            m = re.match(r'(\d{4})-(\d{2})-(\d{2})', str(rd))
            if m:
                det["release_date"] = m.group(0)
        det["description"] = det["description"] or strip_tags(block.get("description") or "") or None
        cat = block.get("category")
        if cat and not det["category"]:
            det["category"] = strip_tags(cat if isinstance(cat, str) else str(cat))

    # --- Fallbacki: meta og:/product: ---
    if not det["cover_url"]:
        m = RE_OG("image").search(html)
        if m:
            det["cover_url"] = m.group(1)
    if not det["title"]:
        m = RE_OG("title").search(html)
        if m:
            det["title"] = strip_tags(m.group(1)) or None
    if not det["category"]:
        m = RE_META_PRODUCT("category2").search(html)
        if m:
            det["category"] = strip_tags(m.group(1)) or None

    # --- Fallbacki: regexy w tresci ---
    if not det["title"]:
        m = RE_H1.search(html)
        if m:
            det["title"] = strip_tags(m.group(1)) or None
    if not det["release_date"]:
        m = RE_DATE_PL.search(html)
        if m:
            det["release_date"] = pl_date_to_iso(m.group(1), m.group(2), m.group(3))
    if not det["ean"]:
        m = RE_EAN_TXT.search(html)
        if m:
            det["ean"] = m.group(1)

    if det["description"]:
        det["description"] = det["description"][:4000]
    return det


def details_complete(det):
    """Komplet = jest tytul, data premiery i opis (reszta mile widziana)."""
    return bool(det.get("title") and det.get("release_date") and det.get("description"))


# ============ SUPABASE ============

def sb_headers(extra=None):
    h = {"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}",
         "Content-Type": "application/json"}
    if extra:
        h.update(extra)
    return h


def sb_get_existing():
    """Mapa {empik_id: {'status':..., 'details_ok':...}} istniejacych wierszy."""
    url = f"{SUPABASE_URL}/rest/v1/empik_proposals?select=empik_id,status,details_ok&limit=10000"
    r = requests.get(url, headers=sb_headers(), timeout=30)
    r.raise_for_status()
    return {row["empik_id"]: row for row in r.json()}


def sb_insert(rows):
    if not rows:
        return
    url = f"{SUPABASE_URL}/rest/v1/empik_proposals"
    r = requests.post(url, headers=sb_headers({"Prefer": "return=minimal"}),
                      data=json.dumps(rows), timeout=30)
    if r.status_code not in (200, 201):
        log(f"INSERT blad {r.status_code}: {r.text[:300]}")
    else:
        log(f"INSERT: {len(rows)} nowych propozycji")


def sb_update_details(empik_id, det, ok):
    """Aktualizuje TYLKO szczegoly - status pozostaje nietkniety."""
    payload = {k: v for k, v in det.items() if v is not None}
    payload["details_ok"] = ok
    payload["updated_at"] = datetime.utcnow().isoformat()
    url = f"{SUPABASE_URL}/rest/v1/empik_proposals?empik_id=eq.{empik_id}"
    r = requests.patch(url, headers=sb_headers({"Prefer": "return=minimal"}),
                       data=json.dumps(payload), timeout=30)
    if r.status_code not in (200, 204):
        log(f"UPDATE {empik_id} blad {r.status_code}: {r.text[:300]}")


# ============ GLOWNY PRZEBIEG ============

def main():
    if not SUPABASE_URL or not SUPABASE_KEY:
        log("BRAK SEKRETOW: ustaw SUPABASE_URL i SUPABASE_SERVICE_KEY")
        sys.exit(1)

    today = date.today().isoformat()

    listing = collect_listing_ids()
    if not listing:
        log("Listing pusty - prawdopodobnie blokada (sprawdz logi HTTP powyzej). Koncze.")
        sys.exit(1)

    existing = sb_get_existing()
    log(f"W bazie: {len(existing)} propozycji; na listingu: {len(listing)}")

    # Kolejka stron produktow: najpierw zupelnie nowe, potem backfill (details_ok=false)
    new_ids = [pid for pid in listing if pid not in existing]
    backfill_ids = [pid for pid in listing
                    if pid in existing and not existing[pid].get("details_ok")
                    and existing[pid].get("status") == "new"]
    queue = (new_ids + backfill_ids)[:DETAILS_BUDGET]
    log(f"Nowych: {len(new_ids)}, do uzupelnienia: {len(backfill_ids)}, w tym przebiegu: {len(queue)}")

    inserts = []
    for pid in queue:
        html = fetch(listing[pid])
        time.sleep(REQUEST_DELAY)
        if not html:
            continue
        det = parse_product(html)
        ok = details_complete(det)

        if det.get("category") and det["category"] in EXCLUDED_CATEGORIES:
            log(f"p{pid}: kategoria wykluczona ({det['category']}) - pomijam")
            continue
        # Zapowiedz z data w przeszlosci nie jest zapowiedzia - pomijamy nowe takie wpisy
        if det.get("release_date") and det["release_date"] < today and pid not in existing:
            log(f"p{pid}: premiera w przeszlosci ({det['release_date']}) - pomijam")
            continue

        if pid not in existing:
            inserts.append({
                "empik_id": pid, "status": "new", "details_ok": ok,
                "title": det["title"] or f"(bez tytulu p{pid})",
                "author": det["author"], "cover_url": det["cover_url"], "ean": det["ean"],
                "release_date": det["release_date"], "description": det["description"],
                "category": det["category"],
            })
            log(f"p{pid}: NOWA - {det['title']!r} ({det['release_date']}) komplet={ok}")
        else:
            sb_update_details(pid, det, ok)
            log(f"p{pid}: uzupelniono szczegoly, komplet={ok}")

    sb_insert(inserts)
    log("Gotowe.")


if __name__ == "__main__":
    main()
