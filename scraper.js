// Empik Zapowiedzi → Supabase (zaczytajsie.pl) — wersja LISTING
// Czyta komplet danych bezpośrednio z listingu zapowiedzi (bez wchodzenia na
// strony produktów — te zwracają 403 z IP GitHub Actions). Z listingu bierzemy:
// tytuł, autora, okładkę (ecsmedia.pl), kategorię, datę premiery, cenę.
// EAN i pełny opis dociąga panel admina przy kliknięciu "Dodaj" (z IP użytkownika).
//
// Wymagane sekrety (env): SUPABASE_URL, SUPABASE_SERVICE_KEY

import { chromium } from "playwright";
import * as cheerio from "cheerio";

const LISTING_URL =
  "https://www.empik.com/zapowiedzi?searchCategory=31&hideUnavailable=true&sort=scoreDesc&availabilitySeparable=przedsprzedaz&qtype=facetForm";

const MAX_PAGES = 10; // 10 × 50 = do 500 pozycji (stop na pustej stronie)
const RESULTS_PER_PAGE = 50;

const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || "";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Supabase (REST) ----------

async function sb(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Supabase ${res.status}: ${body.slice(0, 300)}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function getExistingIds() {
  const ids = new Set();
  let from = 0;
  while (true) {
    const rows = await sb(`empik_proposals?select=id&order=id&limit=1000&offset=${from}`);
    for (const r of rows) ids.add(r.id);
    if (rows.length < 1000) break;
    from += 1000;
  }
  return ids;
}

async function upsertRows(rows) {
  if (rows.length === 0) return;
  await sb(`empik_proposals?on_conflict=id`, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(rows),
  });
}

// ---------- Helpery ----------

function cleanText(s, max) {
  return (s || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function normalizeDate(s) {
  if (!s) return null;
  s = s.trim();
  let m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/(\d{1,2})[.\-\/](\d{1,2})[.\-\/](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return null;
}

function upscaleCover(u) {
  if (!u) return u;
  return u
    .replace(/,(?:w|h)-\d+/gi, "")
    .replace(/([?&])(?:w|h|width|height|size)=\d+/gi, "$1")
    .replace(/[?&]+$/, "");
}

function isValidCover(u) {
  if (!u) return false;
  try {
    return new URL(u).host.includes("ecsmedia.pl");
  } catch {
    return false;
  }
}

// Kategoria z "Książki/Literatura obyczajowa/Literatura obyczajowa"
// → bierzemy ostatni, najbardziej szczegółowy człon (bez wiodącego "Książki").
function pickCategory(raw) {
  if (!raw) return null;
  const parts = cleanText(raw, 200)
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s && !/^książki$/i.test(s));
  if (parts.length === 0) return null;
  return cleanText(parts[parts.length - 1], 80);
}

// ---------- Parsowanie listingu ----------

function parseListing(html) {
  const $ = cheerio.load(html);
  const out = new Map();

  $(".search-list-item").each((_, el) => {
    const $el = $(el);

    // ID produktu
    const id =
      $el.attr("data-product-id") ||
      ($el.find("[data-product-id]").first().attr("data-product-id") || "");
    if (!id || !/^p\d{6,}$/.test(id)) return;

    // Link do produktu
    let href = $el.find("a[href*=',p']").first().attr("href") || "";
    if (!href) href = $el.find("a[href*='ksiazka']").first().attr("href") || "";
    const url = href
      ? `https://www.empik.com${href.split("?")[0]}`
      : `https://www.empik.com/,${id},ksiazka-p`;

    // Tytuł + autor: z atrybutu title linku okładki ("Tytuł - Autor")
    // lub z data-product-name (sam tytuł).
    const linkTitle = cleanText(
      $el.find("a[title]").first().attr("title") ||
        $el.find("img[title]").first().attr("title"),
      400
    );
    const dataName = cleanText($el.attr("data-product-name"), 300);

    let title = null;
    let author = null;
    if (linkTitle && linkTitle.includes(" - ")) {
      const idx = linkTitle.lastIndexOf(" - ");
      title = cleanText(linkTitle.slice(0, idx), 300);
      author = cleanText(linkTitle.slice(idx + 3), 200);
    } else {
      title = dataName || linkTitle || null;
    }
    if (!title) title = dataName || null;
    if (!title) return; // bez tytułu pomijamy

    // Okładka: meta itemprop=image albo img (src / lazy-img), host ecsmedia.pl
    let cover =
      $el.find("meta[itemprop='image']").first().attr("content") ||
      $el.find("img").first().attr("lazy-img") ||
      $el.find("img").first().attr("data-src") ||
      $el.find("img").first().attr("src") ||
      null;
    cover = isValidCover(cover) ? upscaleCover(cover) : null;

    // Kategoria
    const category = pickCategory($el.attr("data-product-category"));

    // Data premiery: z data-delivery ("zapowiedź, premiera: 29.07.2026")
    // albo z dowolnego atrybutu/tekstu ze słowem "premiera".
    let release_date = null;
    const delivery =
      $el.attr("data-delivery") ||
      $el.find("[data-delivery]").first().attr("data-delivery") ||
      "";
    if (/premiera/i.test(delivery)) release_date = normalizeDate(delivery);
    if (!release_date) {
      const txt = $el.text().replace(/\s+/g, " ");
      const m = txt.match(/premiera[:\s]*(\d{1,2}[.\-\/]\d{1,2}[.\-\/]\d{4}|\d{4}-\d{2}-\d{2})/i);
      if (m) release_date = normalizeDate(m[1]);
    }

    // Kompletność na poziomie listingu: tytuł + autor + okładka + kategoria.
    // (EAN i opis dociąga panel przy "Dodaj".)
    const details_ok = Boolean(title && author && cover);

    out.set(id, {
      id,
      url,
      title,
      author: author || null,
      cover_url: cover,
      category,
      release_date,
      details_ok,
    });
  });

  return out;
}

// ---------- Pobieranie listingu przez przeglądarkę ----------

async function getListingHtml(page, url) {
  const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  if (resp && (resp.status() === 403 || resp.status() === 429)) {
    await sleep(4000 + Math.random() * 3000);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  }
  try {
    await page.waitForSelector(".search-list-item", { timeout: 10000 });
  } catch {}
  // przewiń, by dociągnąć leniwie ładowane okładki
  await page.evaluate(() => window.scrollBy(0, document.body.scrollHeight));
  await sleep(800);
  return await page.content();
}

// ---------- Main ----------

async function main() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error("Brak sekretów SUPABASE_URL / SUPABASE_SERVICE_KEY");
  }

  const browser = await chromium.launch({
    args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
  });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    locale: "pl-PL",
    viewport: { width: 1366, height: 900 },
    extraHTTPHeaders: { "Accept-Language": "pl-PL,pl;q=0.9,en;q=0.8" },
  });
  const page = await context.newPage();

  try {
    // Rozgrzewka + baner cookies
    try {
      const resp = await page.goto("https://www.empik.com/", {
        waitUntil: "domcontentloaded",
        timeout: 45000,
      });
      console.log(`Rozgrzewka: HTTP ${resp ? resp.status() : "?"}`);
      for (const sel of [
        "#onetrust-accept-btn-handler",
        "button:has-text('Akceptuję')",
        "button:has-text('Zgadzam')",
      ]) {
        try {
          await page.click(sel, { timeout: 2000 });
          break;
        } catch {}
      }
      await sleep(1200);
    } catch (e) {
      console.warn(`Rozgrzewka nieudana: ${e.message}`);
    }

    // Listing — wszystkie strony
    const all = new Map();
    for (let pageNo = 0; pageNo < MAX_PAGES; pageNo++) {
      const start = pageNo * RESULTS_PER_PAGE + 1;
      const url = `${LISTING_URL}&resultsPP=${RESULTS_PER_PAGE}&start=${start}`;
      try {
        const html = await getListingHtml(page, url);
        const items = parseListing(html);
        console.log(`Strona start=${start}: ${items.size} pozycji`);
        if (items.size === 0) break;
        for (const [id, it] of items) if (!all.has(id)) all.set(id, it);
        await sleep(1500 + Math.random() * 1500);
      } catch (e) {
        console.error(`Błąd strony start=${start}: ${e.message}`);
        if (pageNo === 0) throw e;
        break;
      }
    }
    if (all.size === 0) throw new Error("Pusty listing — możliwa blokada/zmiana HTML.");

    // Diff — ile nowych
    const existing = await getExistingIds();
    const items = [...all.values()];
    const newCount = items.filter((it) => !existing.has(it.id)).length;
    console.log(`\nListing: ${items.length} | nowych: ${newCount}`);

    // Upsert wszystkich (merge-duplicates nie ruszy statusu already-added/dismissed,
    // bo tych pól nie wysyłamy). Zapisujemy komplet z listingu.
    const now = new Date().toISOString();
    const rows = items.map((it) => ({
      id: it.id,
      url: it.url,
      title: it.title,
      author: it.author,
      cover_url: it.cover_url,
      category: it.category,
      release_date: it.release_date,
      details_ok: it.details_ok,
      updated_at: now,
    }));

    // wysyłamy paczkami po 100
    for (let i = 0; i < rows.length; i += 100) {
      await upsertRows(rows.slice(i, i + 100));
    }

    const withCover = items.filter((it) => it.cover_url).length;
    const withAuthor = items.filter((it) => it.author).length;
    const withDate = items.filter((it) => it.release_date).length;
    console.log(
      `Zapisano ${rows.length} | z okładką: ${withCover} | z autorem: ${withAuthor} | z datą: ${withDate}`
    );
    // podgląd 10 pierwszych
    for (const it of items.slice(0, 10)) {
      console.log(
        `  • ${it.title}${it.author ? ` — ${it.author}` : ""}${it.release_date ? ` (${it.release_date})` : ""}${it.cover_url ? "" : " [BRAK OKŁADKI]"}`
      );
    }
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
