// Empik Zapowiedzi → Supabase (zaczytajsie.pl)
// Pobiera listing zapowiedzi Empiku, doczytuje ze stron produktowych komplet
// danych (autor, okładka, EAN, data premiery, opis) i upsertuje do tabeli
// empik_proposals w Supabase. Panel admina czyta z tej tabeli.
//
// Wymagane sekrety (env): SUPABASE_URL, SUPABASE_SERVICE_KEY

import * as cheerio from "cheerio";

const LISTING_URL =
  "https://www.empik.com/zapowiedzi?searchCategory=31&hideUnavailable=true&sort=scoreDesc&availabilitySeparable=przedsprzedaz&qtype=facetForm";

const MAX_PAGES = 5;
const RESULTS_PER_PAGE = 50;
const DETAILS_BUDGET = 50; // max stron produktowych na jeden run

const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || "";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Accept":
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "pl-PL,pl;q=0.9,en;q=0.8",
  "Referer": "https://www.empik.com/",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Supabase (REST, bez zależności) ----------

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
  // Pobieramy id + details_ok wszystkich rekordów (paczkami po 1000)
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

// ---------- Listing ----------

async function fetchListingPage(startPos) {
  const url = `${LISTING_URL}&resultsPP=${RESULTS_PER_PAGE}&start=${startPos}`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} dla start=${startPos}`);
  return await res.text();
}

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

// ---------- Strona produktu: komplet danych ----------

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

// Czyści tytuł z og:title: ucina końcówki typu " - Autor", " - Książka",
// oraz sufiks " | Empik.com" / " | Empik".
function cleanOgTitle(raw) {
  let t = cleanText(raw, 400);
  t = t.replace(/\s*\|\s*Empik(\.com)?\s*$/i, "");
  // "Tytuł - Książka" → "Tytuł"
  t = t.replace(/\s*-\s*Książka\s*$/i, "");
  return cleanText(t, 300);
}

// Empik w og:image podaje URL z parametrem rozmiaru (np. ...,w-360).
// Podnosimy do największego dostępnego wariantu.
function upscaleCover(u) {
  if (!u) return u;
  return u
    .replace(/,(?:w|h)-\d+/gi, "")           // usuń parametry rozmiaru w slug
    .replace(/([?&])(?:w|h|width|height|size)=\d+/gi, "$1") // i w query
    .replace(/[?&]+$/, "");
}

async function fetchProductDetails(p) {
  const out = {
    author: null,
    cover_url: null,
    ean: null,
    release_date: null,
    description: null,
    category: null,
    title: null, // ustalamy ze strony produktu (JSON-LD/og:title), nie z listingu
    details_ok: false,
  };
  const SKIP_CRUMBS = new Set([
    "empik", "empik.com", "strona główna", "książki", "ksiazki",
    "zapowiedzi", "przedsprzedaż", "bestsellery", "nowości", "promocje",
  ]);

  const res = await fetch(p.url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
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
        // EAN: akceptujemy tylko poprawny 13-cyfrowy kod
        const eanCand = String(node.gtin13 || node.gtin || node.isbn || "").replace(/\D/g, "");
        if (!out.ean && /^\d{13}$/.test(eanCand)) out.ean = eanCand;
        const rd = node.releaseDate || node.datePublished;
        if (rd) out.release_date = normalizeDate(String(rd)) || out.release_date;
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

  // 2) Fallbacki i doprecyzowanie z HTML/meta

  // Kategoria: surowa z meta product:category2 (np. "Kryminał, sensacja, thriller").
  // NIE mapujemy tu na gatunki portalu — to robi panel admina.
  if (!out.category) {
    const cat =
      $("meta[property='product:category2']").attr("content") ||
      $("meta[property='product:category']").attr("content");
    if (cat) out.category = cleanText(cat, 80);
  }
  // Fallback kategorii: przedostatni okruszek z breadcrumbów (już policzony wyżej)

  // Tytuł: jeśli JSON-LD nie dał, bierzemy og:title z uciętą końcówką " - Autor"/" - Książka".
  if (!out.title) {
    const ogTitle = cleanOgTitle($("meta[property='og:title']").attr("content"));
    if (ogTitle) out.title = ogTitle;
  }

  // Okładka: og:image z hosta ecsmedia.pl, podniesiona do największego rozmiaru.
  const ogImage = $("meta[property='og:image']").attr("content") || null;
  const coverCandidate = ogImage || out.cover_url;
  out.cover_url = isValidCover(coverCandidate) ? upscaleCover(coverCandidate) : null;

  // Opis: pełny ze strony; og:description tylko jako ostateczność (bywa skrócony).
  if (!out.description) {
    out.description = cleanText(
      $("meta[property='og:description']").attr("content") ||
        $("meta[name='description']").attr("content"),
      3000
    ) || null;
  }

  // EAN: 13 cyfr; szukamy w sekcji szczegółów, potem w całym HTML.
  if (!out.ean) {
    const detail = $("body").text().replace(/\s+/g, " ");
    let m = detail.match(/\bEAN\D{0,15}(\d{13})\b/i) || detail.match(/\bISBN\D{0,15}(\d{13})\b/i);
    if (!m) m = html.match(/\b(97[89]\d{10})\b/);
    if (m) out.ean = m[1];
  }

  // Data premiery: dokładna, format YYYY-MM-DD.
  if (!out.release_date) {
    const flat = html.replace(/\s+/g, " ");
    const m =
      flat.match(/(?:Data premiery|Premiera)\D{0,60}?(\d{4}-\d{2}-\d{2}|\d{1,2}[.\-\/]\d{1,2}[.\-\/]\d{4})/i);
    if (m) out.release_date = normalizeDate(m[1]);
  }

  // Autor: WYŁĄCZNIE z JSON-LD (obsłużone wyżej). Nie pobieramy z breadcrumbów,
  // linków katalogowych ani og:title — tam bywa odwrócona forma "Nazwisko Imię".

  // Jeśli tytuł nadal zawiera doklejoną końcówkę " - Coś" (np. z og:title),
  // ucinamy ją z TYTUŁU, ale NIE traktujemy jako autora.
  if (out.title && out.title.includes(" - ")) {
    const idx = out.title.lastIndexOf(" - ");
    const tail = cleanText(out.title.slice(idx + 3), 200);
    // ucinamy tylko wyraźną końcówkę autorską (krótka, bez cyfr, nie podtytuł/tom)
    if (tail.length <= 60 && !/\d/.test(tail) && !/tom|część|wyd\.|wydanie/i.test(tail)) {
      out.title = cleanText(out.title.slice(0, idx), 300);
    }
  }

  // Kompletność: wpis jest pełny tylko z tytułem, autorem (z JSON-LD),
  // okładką (ecsmedia.pl) i EAN-em. Bez któregokolwiek details_ok=false
  // i kolejne runy spróbują uzupełnić. Lepiej puste niż błędne/odwrócone.
  out.details_ok = Boolean(out.title && out.author && out.cover_url && out.ean);
  return out;
}

// Okładka jest ważna tylko, gdy pochodzi z CDN obrazków Empiku (ecsmedia.pl).
function isValidCover(u) {
  if (!u) return false;
  try {
    return new URL(u).host.includes("ecsmedia.pl");
  } catch {
    return false;
  }
}

// ---------- Main ----------

async function main() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error("Brak sekretów SUPABASE_URL / SUPABASE_SERVICE_KEY");
  }

  // 1. Listing
  const all = new Map();
  for (let page = 0; page < MAX_PAGES; page++) {
    const start = page * RESULTS_PER_PAGE + 1;
    try {
      const html = await fetchListingPage(start);
      const products = parseListing(html);
      console.log(`Strona start=${start}: ${products.size} produktów`);
      if (products.size === 0) break;
      for (const [id, p] of products) all.set(id, p);
      await sleep(2500 + Math.random() * 2000);
    } catch (e) {
      console.error(`Błąd strony start=${start}: ${e.message}`);
      if (page === 0) throw e;
      break;
    }
  }
  if (all.size === 0) throw new Error("Pusty listing — możliwa blokada/zmiana HTML.");

  // 2. Co już mamy w bazie
  const existing = await getExisting();
  const newOnes = [...all.values()].filter((p) => !existing.has(p.id));
  const needBackfill = [...all.values()].filter(
    (p) => existing.has(p.id) && existing.get(p.id) === false
  );
  console.log(
    `\nListing: ${all.size} | nowych: ${newOnes.length} | do uzupełnienia: ${needBackfill.length}`
  );

  // 3. Nowe bez szczegółów wrzucamy od razu (żeby nic nie zginęło),
  //    szczegóły doczytujemy w ramach budżetu
  await upsertRows(
    newOnes.map((p) => ({ id: p.id, title: p.title, url: p.url }))
  );

  const queue = [...newOnes, ...needBackfill].slice(0, DETAILS_BUDGET);
  let done = 0;
  for (const p of queue) {
    try {
      const d = await fetchProductDetails(p);
      // title jest NOT NULL w bazie — awaryjnie użyj tytułu z listingu
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
    await sleep(1800 + Math.random() * 1200);
  }

  console.log(`\nSzczegóły pobrane: ${done}/${queue.length}`);
  if (queue.length > DETAILS_BUDGET) {
    console.log("Reszta zostanie uzupełniona w kolejnych runach.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
