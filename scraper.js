// Empik Zapowiedzi → Supabase (zaczytajsie.pl) — wersja Playwright
// Używa prawdziwej przeglądarki (headless Chromium), żeby ominąć blokadę 403
// na stronach produktów. Logika parsowania i zapisu jak w wersji fetch.
//
// Wymagane sekrety (env): SUPABASE_URL, SUPABASE_SERVICE_KEY

import { chromium } from "playwright";
import * as cheerio from "cheerio";

const LISTING_URL =
  "https://www.empik.com/zapowiedzi?searchCategory=31&hideUnavailable=true&sort=scoreDesc&availabilitySeparable=przedsprzedaz&qtype=facetForm";

const MAX_PAGES = 8; // 8 × 50 = do 400 pozycji (stop na pustej stronie)
const RESULTS_PER_PAGE = 50;
const DETAILS_BUDGET = 60; // max stron produktowych na jeden run

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

async function getExisting() {
  const map = new Map();
  let from = 0;
  while (true) {
    const rows = await sb(
      `empik_proposals?select=id,details_ok&order=id&limit=1000&offset=${from}`
    );
    for (const r of rows) map.set(r.id, r.details_ok);
    if (rows.length < 1000) break;
    from += 1000;
  }
  return map;
}

async function upsertRows(rows) {
  if (rows.length === 0) return;
  await sb(`empik_proposals?on_conflict=id`, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(rows),
  });
}

// ---------- Pobieranie przez przeglądarkę ----------

async function getHtml(page, url, { waitFor } = {}) {
  const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  const status = resp ? resp.status() : 0;
  if (status === 403 || status === 429) {
    await sleep(4000 + Math.random() * 3000);
    const resp2 = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    if (resp2 && (resp2.status() === 403 || resp2.status() === 429)) {
      throw new Error(`HTTP ${resp2.status()}`);
    }
  }
  if (waitFor) {
    try {
      await page.waitForSelector(waitFor, { timeout: 8000 });
    } catch {}
  }
  await sleep(400);
  return await page.content();
}

// ---------- Listing ----------

function parseListing(html) {
  const $ = cheerio.load(html);
  const products = new Map();
  $("a[href*=',p']").each((_, el) => {
    const href = $(el).attr("href") || "";
    const m = href.match(/,(p\d{6,}),/);
    if (!m) return;
    const id = m[1];
    let title =
      $(el).attr("title") ||
      $(el).find("[class*='title'], strong, span").first().text().trim() ||
      $(el).text().trim();
    title = title.replace(/\s+/g, " ").trim();
    const existing = products.get(id);
    if (!existing || (title && title.length > existing.title.length)) {
      products.set(id, {
        id,
        title: title.slice(0, 300),
        url: `https://www.empik.com${href.split("?")[0]}`,
      });
    }
  });
  return products;
}

// ---------- Helpery parsujące ----------

function normalizeDate(s) {
  if (!s) return null;
  s = s.trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[.\-\/](\d{1,2})[.\-\/](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return null;
}

function cleanText(s, max) {
  return (s || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function cleanOgTitle(raw) {
  let t = cleanText(raw, 400);
  t = t.replace(/\s*\|\s*Empik(\.com)?\s*$/i, "");
  t = t.replace(/\s*-\s*Książka\s*$/i, "");
  return cleanText(t, 300);
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

// ---------- Strona produktu: komplet danych ----------

function extractDetails(html) {
  const out = {
    author: null,
    cover_url: null,
    ean: null,
    release_date: null,
    description: null,
    category: null,
    title: null,
    details_ok: false,
  };
  const SKIP_CRUMBS = new Set([
    "empik", "empik.com", "strona główna", "książki", "ksiazki",
    "zapowiedzi", "przedsprzedaż", "bestsellery", "nowości", "promocje",
  ]);

  const $ = cheerio.load(html);

  // 1) JSON-LD: Product / Book / BreadcrumbList
  $("script[type='application/ld+json']").each((_, el) => {
    let data;
    try {
      data = JSON.parse($(el).contents().text());
    } catch {
      return;
    }
    const nodes = [].concat(data).flatMap((d) => (d && d["@graph"] ? d["@graph"] : [d]));
    for (const node of nodes) {
      if (!node || !node["@type"]) continue;
      const types = [].concat(node["@type"]);

      if (types.includes("Product") || types.includes("Book")) {
        if (node.name && !out.title) out.title = cleanText(node.name, 300);
        if (node.description) out.description = cleanText(node.description, 3000);
        const img = Array.isArray(node.image) ? node.image[0] : node.image;
        const imgUrl = typeof img === "string" ? img : img?.url || null;
        if (imgUrl && !out.cover_url) out.cover_url = imgUrl;
        const eanCand = String(node.gtin13 || node.gtin || node.isbn || "").replace(/\D/g, "");
        if (!out.ean && /^\d{13}$/.test(eanCand)) out.ean = eanCand;
        const rd = node.releaseDate || node.datePublished;
        if (rd) out.release_date = normalizeDate(String(rd)) || out.release_date;
        // Autor WYŁĄCZNIE z JSON-LD (naturalna forma "Imię Nazwisko")
        const authors = [].concat(node.author || []).map((a) =>
          typeof a === "string" ? a : a?.name || ""
        );
        const authorStr = authors.filter(Boolean).join(", ");
        if (authorStr && !out.author) out.author = cleanText(authorStr, 200);
      }

      if (types.includes("BreadcrumbList")) {
        const crumbs = (node.itemListElement || [])
          .sort((a, b) => (a.position || 0) - (b.position || 0))
          .map((i) => cleanText(i.name || i.item?.name || "", 60))
          .filter((c) => c && !SKIP_CRUMBS.has(c.toLowerCase()));
        if (crumbs.length > 0) {
          const last = crumbs[crumbs.length - 1];
          out.category =
            crumbs.length >= 2 && last.length > 40 ? crumbs[crumbs.length - 2] : last;
        }
      }
    }
  });

  // 2) Fallbacki z meta/HTML
  if (!out.category) {
    const cat =
      $("meta[property='product:category2']").attr("content") ||
      $("meta[property='product:category']").attr("content");
    if (cat) out.category = cleanText(cat, 80);
  }

  if (!out.title) {
    const ogTitle = cleanOgTitle($("meta[property='og:title']").attr("content"));
    if (ogTitle) out.title = ogTitle;
  }

  const ogImage = $("meta[property='og:image']").attr("content") || null;
  const coverCandidate = ogImage || out.cover_url;
  out.cover_url = isValidCover(coverCandidate) ? upscaleCover(coverCandidate) : null;

  if (!out.description) {
    out.description =
      cleanText(
        $("meta[property='og:description']").attr("content") ||
          $("meta[name='description']").attr("content"),
        3000
      ) || null;
  }

  if (!out.ean) {
    const detail = $("body").text().replace(/\s+/g, " ");
    let m = detail.match(/\bEAN\D{0,15}(\d{13})\b/i) || detail.match(/\bISBN\D{0,15}(\d{13})\b/i);
    if (!m) m = html.match(/\b(97[89]\d{10})\b/);
    if (m) out.ean = m[1];
  }

  if (!out.release_date) {
    const flat = html.replace(/\s+/g, " ");
    const m = flat.match(
      /(?:Data premiery|Premiera)\D{0,60}?(\d{4}-\d{2}-\d{2}|\d{1,2}[.\-\/]\d{1,2}[.\-\/]\d{4})/i
    );
    if (m) out.release_date = normalizeDate(m[1]);
  }

  // Tytuł: ucinamy doklejoną końcówkę " - Coś", ale nie traktujemy jej jako autora.
  if (out.title && out.title.includes(" - ")) {
    const idx = out.title.lastIndexOf(" - ");
    const tail = cleanText(out.title.slice(idx + 3), 200);
    if (tail.length <= 60 && !/\d/.test(tail) && !/tom|część|wyd\.|wydanie/i.test(tail)) {
      out.title = cleanText(out.title.slice(0, idx), 300);
    }
  }

  out.details_ok = Boolean(out.title && out.author && out.cover_url && out.ean);
  return out;
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
    // 0. Rozgrzewka
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
      await sleep(1500);
    } catch (e) {
      console.warn(`Rozgrzewka nieudana: ${e.message}`);
    }

    // 1. Listing
    const all = new Map();
    for (let pageNo = 0; pageNo < MAX_PAGES; pageNo++) {
      const start = pageNo * RESULTS_PER_PAGE + 1;
      const url = `${LISTING_URL}&resultsPP=${RESULTS_PER_PAGE}&start=${start}`;
      try {
        const html = await getHtml(page, url, { waitFor: "a[href*=',p']" });
        const products = parseListing(html);
        console.log(`Strona start=${start}: ${products.size} produktów`);
        if (products.size === 0) break;
        for (const [id, p] of products) all.set(id, p);
        await sleep(2000 + Math.random() * 2000);
      } catch (e) {
        console.error(`Błąd strony start=${start}: ${e.message}`);
        if (pageNo === 0) throw e;
        break;
      }
    }
    if (all.size === 0) throw new Error("Pusty listing — możliwa blokada/zmiana HTML.");

    // 2. Diff
    const existing = await getExisting();
    const newOnes = [...all.values()].filter((p) => !existing.has(p.id));
    const needBackfill = [...all.values()].filter(
      (p) => existing.has(p.id) && existing.get(p.id) === false
    );
    console.log(
      `\nListing: ${all.size} | nowych: ${newOnes.length} | do uzupełnienia: ${needBackfill.length}`
    );

    // 3. Nowe wrzucamy od razu (id+tytuł+url), szczegóły w budżecie
    await upsertRows(newOnes.map((p) => ({ id: p.id, title: p.title, url: p.url })));

    const queue = [...newOnes, ...needBackfill].slice(0, DETAILS_BUDGET);
    let done = 0;
    for (const p of queue) {
      try {
        const html = await getHtml(page, p.url, { waitFor: "script[type='application/ld+json']" });
        const d = extractDetails(html);
        const safeTitle = d.title || cleanText(p.title, 300);
        await upsertRows([
          {
            id: p.id,
            url: p.url,
            title: safeTitle,
            author: d.author,
            cover_url: d.cover_url,
            ean: d.ean,
            release_date: d.release_date,
            description: d.description,
            category: d.category,
            details_ok: d.details_ok,
            updated_at: new Date().toISOString(),
          },
        ]);
        done++;
        console.log(
          `  ✓ ${safeTitle}${d.author ? ` — ${d.author}` : ""}${d.release_date ? ` (${d.release_date})` : ""}${d.details_ok ? "" : " [niepełne]"}`
        );
      } catch (e) {
        console.error(`  ✗ ${p.title}: ${e.message}`);
      }
      await sleep(1500 + Math.random() * 1500);
    }

    console.log(`\nSzczegóły pobrane: ${done}/${queue.length}`);
    if (newOnes.length + needBackfill.length > DETAILS_BUDGET) {
      console.log("Reszta zostanie uzupełniona w kolejnych runach.");
    }
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
