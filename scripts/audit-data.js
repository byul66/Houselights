// Data-accuracy audit for Houselights.
//
// Walks every title in public/index.html's countries{}/movies{}/data{} objects and
// cross-checks it against TMDB + OMDb the same way the live server does (exact-year TMDB
// search with a fallback, OMDb looked up by IMDb ID when available). Flags anything that
// couldn't be verified or that looks like it might be pointing at the wrong film, so this
// project's "never invent or pad data" rule can be checked sitewide without opening every
// movie page by hand.
//
// Usage: node scripts/audit-data.js [--limit N] [--only box|recognized|global|curated]

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const TMDB_API_KEY = process.env.TMDB_API_KEY;
const OMDB_API_KEY = process.env.OMDB_API_KEY;
if (!TMDB_API_KEY || !OMDB_API_KEY) {
  console.error('TMDB_API_KEY and OMDB_API_KEY must be set in .env to run the audit.');
  process.exit(1);
}

const args = process.argv.slice(2);
const limitArg = args.indexOf('--limit');
const LIMIT = limitArg !== -1 ? parseInt(args[limitArg + 1], 10) : Infinity;
const onlyArg = args.indexOf('--only');
const ONLY = onlyArg !== -1 ? args[onlyArg + 1] : null;

function extractObjectLiteral(source, varName, context) {
  const marker = `var ${varName} = `;
  const start = source.indexOf(marker);
  if (start === -1) throw new Error(`Could not find "${marker}" in index.html`);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  let i = braceStart;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  const literal = source.slice(braceStart, i);
  return vm.runInNewContext(`(${literal})`, context || {});
}

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
// `countries` references `data` (e.g. South Korea's box list reuses data.globalBox), so
// data has to be extracted and made available first.
const data = extractObjectLiteral(html, 'data');
const countries = extractObjectLiteral(html, 'countries', { data });
const movies = extractObjectLiteral(html, 'movies');

// Country display names as they appear in TMDB's production_countries, for the loose
// same-country check below. Extend as needed if new countries get added.
const COUNTRY_ALIASES = {
  'United States': ['United States of America'],
  'South Korea': ['South Korea', 'Korea'],
  'United Kingdom': ['United Kingdom'],
};
function countriesRoughlyMatch(expected, actual) {
  if (!expected || !actual) return true; // nothing to compare
  if (expected === actual) return true;
  const aliases = COUNTRY_ALIASES[expected] || [expected];
  return aliases.some((a) => a.toLowerCase() === actual.toLowerCase());
}

// Cheap similarity check so an OMDb fuzzy-title fallback match that's clearly a different
// film gets flagged for a human to look at (mirrors the "ATM" vs "ATM: Er Rak Error" case).
function normalize(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
function looksLikeDifferentFilm(storedTitle, otherTitle) {
  const a = normalize(storedTitle);
  const b = normalize(otherTitle);
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return false;
  const aWords = new Set(a.split(' '));
  const bWords = new Set(b.split(' '));
  const shared = [...aWords].filter((w) => bWords.has(w)).length;
  const smaller = Math.min(aWords.size, bWords.size);
  return shared / smaller < 0.5;
}

// Collect every title referenced anywhere on the site, deduped by title+year so each film
// is only checked once even if it appears on multiple lists (e.g. a global list and its
// own country page).
const items = new Map();
function addItem(entry) {
  const key = `${entry.title.toLowerCase()}::${entry.year || ''}`;
  if (items.has(key)) {
    items.get(key).sources.push(entry.source);
    return;
  }
  items.set(key, { title: entry.title, year: entry.year, expectedCountry: entry.expectedCountry || null, sources: [entry.source] });
}

if (!ONLY || ONLY === 'box' || ONLY === 'recognized') {
  Object.keys(countries).forEach((slug) => {
    const c = countries[slug];
    if (!ONLY || ONLY === 'box') {
      (c.box || []).forEach((m) => addItem({ title: m.t, year: m.y, expectedCountry: c.name, source: `${slug}/box` }));
    }
    if (!ONLY || ONLY === 'recognized') {
      (c.recognized || []).forEach((m) => addItem({ title: m.t, year: m.y, expectedCountry: c.name, source: `${slug}/recognized` }));
    }
  });
}
if (!ONLY || ONLY === 'global') {
  ['globalBox', 'globalThisWeek', 'globalPicture', 'globalPalme', 'globalLion', 'globalBear', 'globalImdb']
    .forEach((key) => {
      (data[key] || []).forEach((m) => addItem({ title: m.t, year: m.y, expectedCountry: null, source: `global/${key}` }));
    });
}
if (!ONLY || ONLY === 'curated') {
  Object.keys(movies).forEach((slug) => {
    const m = movies[slug];
    addItem({ title: m.title, year: m.year, expectedCountry: m.country, source: `curated/${slug}` });
  });
}

const list = [...items.values()].slice(0, LIMIT);
console.log(`Auditing ${list.length} unique titles (of ${items.size} found)...\n`);

// Mirrors server.js's preferExactTitleMatch: a year filter alone doesn't disambiguate a
// generic title (e.g. "Hotel" 2023 Iran vs. "The Royal Hotel" 2023 Australia), so an exact
// title match is promoted ahead of TMDB's popularity-ranked order.
function preferExactTitleMatch(results, title) {
  if (!results.length) return results;
  const q = title.trim().toLowerCase();
  const exact = results.filter((r) => (r.title || '').trim().toLowerCase() === q || (r.original_title || '').trim().toLowerCase() === q);
  if (!exact.length) return results;
  const rest = results.filter((r) => !exact.includes(r));
  return exact.concat(rest);
}

async function searchTmdbMovie(title, year) {
  const params = new URLSearchParams({ api_key: TMDB_API_KEY, query: title });
  if (year) params.set('primary_release_year', year);
  const res = await fetch(`https://api.themoviedb.org/3/search/movie?${params}`);
  if (!res.ok) return [];
  const d = await res.json();
  if (year && (!d.results || !d.results.length)) {
    const fbParams = new URLSearchParams({ api_key: TMDB_API_KEY, query: title });
    const fbRes = await fetch(`https://api.themoviedb.org/3/search/movie?${fbParams}`);
    if (fbRes.ok) {
      const fbData = await fbRes.json();
      const ordered = preferExactTitleMatch(fbData.results || [], title);
      const q = title.trim().toLowerCase();
      return ordered.filter((r) => (r.title || '').trim().toLowerCase() === q || (r.original_title || '').trim().toLowerCase() === q);
    }
  }
  return preferExactTitleMatch(d.results || [], title);
}

async function getTmdbDetails(id) {
  const params = new URLSearchParams({ api_key: TMDB_API_KEY, append_to_response: 'external_ids' });
  const res = await fetch(`https://api.themoviedb.org/3/movie/${id}?${params}`);
  if (!res.ok) return null;
  const t = await res.json();
  const country = (t.production_countries && t.production_countries[0] && t.production_countries[0].name) || null;
  return {
    id: t.id,
    title: t.title,
    year: t.release_date ? t.release_date.slice(0, 4) : null,
    country,
    imdbId: (t.external_ids && t.external_ids.imdb_id) || null
  };
}

async function omdbById(imdbId) {
  const params = new URLSearchParams({ apikey: OMDB_API_KEY, i: imdbId });
  const res = await fetch(`https://www.omdbapi.com/?${params}`);
  if (!res.ok) return null;
  const d = await res.json();
  return d.Response === 'False' ? null : d;
}
async function omdbByTitle(title, year) {
  const params = new URLSearchParams({ apikey: OMDB_API_KEY, t: title });
  if (year) params.set('y', year);
  const res = await fetch(`https://www.omdbapi.com/?${params}`);
  if (!res.ok) return null;
  const d = await res.json();
  return d.Response === 'False' ? null : d;
}

const flags = [];
let checked = 0;

// Small concurrency limit — polite to both APIs and avoids OMDb's free-tier daily cap
// getting blown through by a single run.
const CONCURRENCY = 4;
async function runPool(items, worker) {
  let idx = 0;
  async function next() {
    while (idx < items.length) {
      const i = idx++;
      await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, next));
}

async function main() {
  await runPool(list, async (item) => {
  checked++;
  process.stdout.write(`\r${checked}/${list.length}`);
  const label = `"${item.title}"${item.year ? ` (${item.year})` : ''} [${item.sources.join(', ')}]`;

  const results = await searchTmdbMovie(item.title, item.year).catch(() => []);
  const match = results[0];
  if (!match) {
    flags.push({ level: 'error', label, message: 'No TMDB match found at all.' });
    return;
  }

  const t = await getTmdbDetails(match.id).catch(() => null);
  if (!t) {
    flags.push({ level: 'error', label, message: 'TMDB match found but detail fetch failed.' });
    return;
  }

  if (item.year && t.year && Math.abs(parseInt(t.year, 10) - parseInt(item.year, 10)) > 1) {
    flags.push({ level: 'warn', label, message: `TMDB year (${t.year}) differs from stored year (${item.year}) by more than 1 — check this is the same film.` });
  }
  if (looksLikeDifferentFilm(item.title, t.title)) {
    flags.push({ level: 'warn', label, message: `TMDB matched title "${t.title}" looks quite different from the stored title — verify by hand.` });
  }
  if (item.expectedCountry && !countriesRoughlyMatch(item.expectedCountry, t.country)) {
    flags.push({ level: 'warn', label, message: `Expected country "${item.expectedCountry}" but TMDB lists "${t.country || 'none'}" — may be a legitimate co-production, or a mismatch.` });
  }

  let omdb = null;
  let omdbSource = null;
  if (t.imdbId) {
    omdb = await omdbById(t.imdbId).catch(() => null);
    omdbSource = 'imdb_id';
  }
  if (!omdb) {
    omdb = await omdbByTitle(item.title, item.year).catch(() => null);
    omdbSource = 'title fallback';
  }
  if (!omdb || !omdb.imdbRating || omdb.imdbRating === 'N/A') {
    flags.push({ level: 'info', label, message: 'No OMDb/IMDb rating found — site should show "Not available", not a number.' });
  } else if (omdbSource === 'title fallback' && looksLikeDifferentFilm(item.title, omdb.Title)) {
    flags.push({ level: 'error', label, message: `No TMDB imdb_id on file, and the OMDb title-fallback match "${omdb.Title}" (${omdb.Year}) looks like a different film — likely showing the WRONG rating. Verify manually.` });
  }
  });

  console.log('\n');
  if (!flags.length) {
    console.log('No issues found.');
  } else {
    const order = { error: 0, warn: 1, info: 2 };
    flags.sort((a, b) => order[a.level] - order[b.level]);
    flags.forEach((f) => {
      const tag = f.level === 'error' ? '[LIKELY WRONG]' : f.level === 'warn' ? '[CHECK THIS]' : '[UNVERIFIED]';
      console.log(`${tag} ${f.label}\n  ${f.message}\n`);
    });
    console.log(`${flags.length} flag(s) across ${checked} titles checked.`);
  }
}

main();
