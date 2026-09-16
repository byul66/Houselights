require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');

const TMDB_API_KEY = process.env.TMDB_API_KEY;
const OMDB_API_KEY = process.env.OMDB_API_KEY;
const PORT = process.env.PORT || 3000;

const app = express();
// index:false so "/" falls through to our own handler below instead of being
// auto-served — that handler is what injects per-page Open Graph tags.
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// In-memory cache so repeated page loads/searches don't burn API quota.
const cache = new Map();

// A year filter alone isn't enough to disambiguate a generic title: e.g. "Hotel" (2023,
// Iran) and "The Royal Hotel" (2023, Australia) both pass a primary_release_year=2023
// filter, and TMDB's own relevance ranking put the more popular, unrelated "The Royal
// Hotel" first. An exact (case-insensitive) title match is a much stronger correctness
// signal than TMDB's popularity-weighted ranking, so promote any exact matches to the
// front while otherwise preserving TMDB's order.
function preferExactTitleMatch(results, title) {
  if (!results.length) return results;
  const q = title.trim().toLowerCase();
  const exact = results.filter((r) => (r.title || '').trim().toLowerCase() === q || (r.original_title || '').trim().toLowerCase() === q);
  if (!exact.length) return results;
  const rest = results.filter((r) => !exact.includes(r));
  return exact.concat(rest);
}

// Searches TMDB by title, preferring an exact primary_release_year match when a year is
// given. The loose `year` param TMDB also accepts only nudges relevance — it doesn't filter
// — which is how an unrelated same-title film (e.g. "Taxi Driver", 1976) could outrank the
// real match (e.g. "Taxi", 2015, Iran) for an ambiguous query. Falls back to a year-less
// search if the exact-year search comes up empty, in case our stored year is off by one
// (festival premiere vs. wide release, etc).
async function searchTmdbMovie(title, year) {
  const params = new URLSearchParams({ api_key: TMDB_API_KEY, query: title });
  if (year) params.set('primary_release_year', year);
  const res = await fetch(`https://api.themoviedb.org/3/search/movie?${params}`);
  if (!res.ok) return { results: [], ok: false, status: res.status };
  const data = await res.json();
  if (year && (!data.results || !data.results.length)) {
    const fallbackParams = new URLSearchParams({ api_key: TMDB_API_KEY, query: title });
    const fallbackRes = await fetch(`https://api.themoviedb.org/3/search/movie?${fallbackParams}`).catch(() => null);
    if (fallbackRes && fallbackRes.ok) {
      const fallbackData = await fallbackRes.json();
      const ordered = preferExactTitleMatch(fallbackData.results || [], title);
      // With no year corroboration at all, only trust an exact title match here — a mere
      // substring/fuzzy match (TMDB's own relevance ranking) is exactly how "Hard Asphalt"
      // (1986, Norway) silently grabbed an unrelated 1989 Italian film instead of admitting
      // no confident match exists.
      const q = title.trim().toLowerCase();
      const exact = ordered.filter((r) => (r.title || '').trim().toLowerCase() === q || (r.original_title || '').trim().toLowerCase() === q);
      return { results: exact, ok: true };
    }
  }
  return { results: preferExactTitleMatch(data.results || [], title), ok: true };
}

async function lookupTmdbPoster(title, year) {
  if (!TMDB_API_KEY) {
    return { url: null, reason: 'TMDB_API_KEY not configured' };
  }
  const { results, ok, status } = await searchTmdbMovie(title, year);
  if (!ok) {
    return { url: null, reason: `TMDB request failed (${status})` };
  }
  const match = results[0];
  if (!match || !match.poster_path) {
    return { url: null, reason: `No TMDB poster found for "${title}"` };
  }
  return {
    url: `https://image.tmdb.org/t/p/w500${match.poster_path}`,
    tmdbId: match.id,
    source: 'tmdb'
  };
}

async function lookupOmdbRating(title, year) {
  if (!OMDB_API_KEY) {
    return { rating: null, reason: 'OMDB_API_KEY not configured' };
  }
  const params = new URLSearchParams({ apikey: OMDB_API_KEY, t: title });
  if (year) params.set('y', year);
  const res = await fetch(`https://www.omdbapi.com/?${params}`);
  if (!res.ok) {
    return { rating: null, reason: `OMDb request failed (${res.status})` };
  }
  const data = await res.json();
  if (data.Response === 'False' || !data.imdbRating || data.imdbRating === 'N/A') {
    return { rating: null, reason: data.Error || `No OMDb rating found for "${title}"` };
  }
  return {
    rating: data.imdbRating,
    imdbId: data.imdbID,
    source: 'omdb',
    awards: data.Awards && data.Awards !== 'N/A' ? data.Awards : null
  };
}

// Looking OMDb up by IMDb ID (sourced from TMDB's own external_ids) instead of by title
// text avoids a whole class of silent mismatches: a generic TMDB title like "ATM" can
// collide with an unrelated same-year Hollywood film of the same name, and OMDb's fuzzy
// title search has no way to know which one we meant. An ID lookup is unambiguous.
async function lookupOmdbById(imdbId) {
  if (!OMDB_API_KEY) {
    return { rating: null, reason: 'OMDB_API_KEY not configured' };
  }
  if (!imdbId) {
    return { rating: null, reason: 'No IMDb ID available from TMDB' };
  }
  const params = new URLSearchParams({ apikey: OMDB_API_KEY, i: imdbId });
  const res = await fetch(`https://www.omdbapi.com/?${params}`);
  if (!res.ok) {
    return { rating: null, reason: `OMDb request failed (${res.status})` };
  }
  const data = await res.json();
  if (data.Response === 'False' || !data.imdbRating || data.imdbRating === 'N/A') {
    return { rating: null, reason: data.Error || `No OMDb rating found for ${imdbId}` };
  }
  return {
    rating: data.imdbRating,
    imdbId: data.imdbID,
    source: 'omdb',
    awards: data.Awards && data.Awards !== 'N/A' ? data.Awards : null
  };
}

// Resolves the IMDb rating for an already-fetched TMDB detail record: prefer the exact
// imdb_id cross-reference, and only fall back to a fuzzy title+year OMDb search (which can
// mismatch on ambiguous titles) when TMDB has no imdb_id on file for the title.
async function lookupOmdbForTmdb(t) {
  if (t && t.imdbId) {
    const byId = await lookupOmdbById(t.imdbId);
    if (byId.rating) return byId;
  }
  return lookupOmdbRating(t.title, t.year);
}

app.get('/api/movie-data', async (req, res) => {
  const { title, year } = req.query;
  if (!title) {
    return res.status(400).json({ error: 'title query param is required' });
  }

  const cacheKey = `${title}::${year || ''}`;
  if (cache.has(cacheKey)) {
    return res.json(cache.get(cacheKey));
  }

  const poster = await lookupTmdbPoster(title, year).catch((err) => ({ url: null, reason: err.message }));
  const t = poster.tmdbId ? await getTmdbDetails(poster.tmdbId).catch(() => null) : null;
  const [imdb, watch] = await Promise.all([
    (t ? lookupOmdbForTmdb(t) : lookupOmdbRating(title, year)).catch((err) => ({ rating: null, reason: err.message })),
    poster.tmdbId
      ? getWatchProviders(poster.tmdbId).catch(() => ({ providers: [], link: null }))
      : Promise.resolve({ providers: [], link: null })
  ]);

  const result = { poster, imdb, watch };
  // Don't cache a failed OMDb lookup — the in-memory cache has no expiry, so caching a
  // transient failure (e.g. OMDb's free-tier daily request cap, which resets on its own)
  // would keep serving "Not available" long after the underlying data is fetchable again.
  if (imdb.rating) cache.set(cacheKey, result);
  res.json(result);
});

// Lightweight row-details lookup (poster + director + cast) for list rows across the
// site — skips OMDb entirely (rating is only needed on the movie page itself) so this
// stays cheap even across hundreds of rows.
app.get('/api/poster', async (req, res) => {
  const { title, year } = req.query;
  if (!title) {
    return res.status(400).json({ error: 'title query param is required' });
  }
  const cacheKey = `row-details:${title}::${year || ''}`;
  if (cache.has(cacheKey)) {
    return res.json(cache.get(cacheKey));
  }
  if (!TMDB_API_KEY) {
    const result = { url: null, director: null, cast: [], reason: 'TMDB_API_KEY not configured' };
    cache.set(cacheKey, result);
    return res.json(result);
  }

  const { results } = await searchTmdbMovie(title, year);
  const match = results[0];
  if (!match) {
    const result = { url: null, director: null, cast: [], reason: `No TMDB match found for "${title}"` };
    cache.set(cacheKey, result);
    return res.json(result);
  }

  const [t, watch] = await Promise.all([
    getTmdbDetails(match.id).catch(() => null),
    getWatchProviders(match.id).catch(() => ({ providers: [], link: null }))
  ]);
  const result = t
    ? { url: t.posterThumbUrl, director: t.director, cast: t.cast, country: t.country, providers: watch.providers }
    : { url: null, director: null, cast: [], providers: [], reason: 'TMDB detail request failed' };
  cache.set(cacheKey, result);
  res.json(result);
});

// Fallback when TMDB doesn't return production_countries for a title.
const LANG_COUNTRY = {
  ko: 'South Korea', th: 'Thailand', ja: 'Japan', fr: 'France', de: 'Germany',
  it: 'Italy', es: 'Spain', fa: 'Iran', sv: 'Sweden', da: 'Denmark', no: 'Norway', fi: 'Finnish'
};

async function getTmdbDetails(id) {
  const cacheKey = `details:${id}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const params = new URLSearchParams({ api_key: TMDB_API_KEY, append_to_response: 'credits,external_ids' });
  const res = await fetch(`https://api.themoviedb.org/3/movie/${id}?${params}`);
  if (!res.ok) return null;
  const t = await res.json();
  if (t.success === false) return null;

  const crew = (t.credits && t.credits.crew) || [];
  const cast = (t.credits && t.credits.cast) || [];
  const director = crew.find((c) => c.job === 'Director');
  const country = (t.production_countries && t.production_countries[0] && t.production_countries[0].name)
    || LANG_COUNTRY[t.original_language] || null;

  const result = {
    id: t.id,
    title: t.title,
    year: t.release_date ? t.release_date.slice(0, 4) : null,
    genres: (t.genres || []).map((g) => g.name),
    posterUrl: t.poster_path ? `https://image.tmdb.org/t/p/w500${t.poster_path}` : null,
    posterThumbUrl: t.poster_path ? `https://image.tmdb.org/t/p/w92${t.poster_path}` : null,
    budget: t.budget || 0,
    revenue: t.revenue || 0,
    country,
    director: director ? director.name : null,
    cast: cast.slice(0, 3).map((c) => c.name),
    imdbId: (t.external_ids && t.external_ids.imdb_id) || null
  };
  cache.set(cacheKey, result);
  return result;
}

// "Where to watch" data comes from JustWatch via TMDB. TMDB does not provide a direct
// deep link into e.g. Netflix's own page for a title — only its own aggregator "watch"
// page, which itself links out to each provider. Region defaults to US since the site
// has no geo-detection; JustWatch attribution is required per-title per their terms.
const WATCH_REGION = 'US';

async function getWatchProviders(id) {
  const cacheKey = `providers:${id}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const res = await fetch(`https://api.themoviedb.org/3/movie/${id}/watch/providers?api_key=${TMDB_API_KEY}`).catch(() => null);
  if (!res || !res.ok) return { providers: [], link: null };
  const data = await res.json();
  const regionData = data.results && data.results[WATCH_REGION];
  if (!regionData) return { providers: [], link: null };

  const flatrate = regionData.flatrate || [];
  const result = {
    providers: flatrate.map((p) => ({
      name: p.provider_name,
      logoUrl: p.logo_path ? `https://image.tmdb.org/t/p/w45${p.logo_path}` : null
    })),
    link: regionData.link || null
  };
  cache.set(cacheKey, result);
  return result;
}

// ISO 3166-1 codes for TMDB's discover `with_origin_country` filter, keyed by the same
// slugs used in COUNTRY_NAMES/the URL routes.
const COUNTRY_CODES = {
  thailand: 'TH', 'south-korea': 'KR', japan: 'JP', 'united-states': 'US',
  'united-kingdom': 'GB', france: 'FR', germany: 'DE', italy: 'IT', spain: 'ES',
  iran: 'IR', sweden: 'SE', denmark: 'DK', norway: 'NO', finland: 'FI'
};

const IMDB_RATING_FLOOR = 6.0;

app.get('/api/top-imdb', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const countrySlug = req.query.country || null;
  const countryCode = countrySlug ? COUNTRY_CODES[countrySlug] : null;
  if (countrySlug && !countryCode) {
    return res.status(400).json({ error: `Unknown country "${countrySlug}"` });
  }
  if (!TMDB_API_KEY) {
    return res.json({ results: [], reason: 'TMDB_API_KEY not configured' });
  }

  const cacheKey = `top-imdb:${countrySlug || 'global'}:${page}`;
  if (cache.has(cacheKey)) {
    return res.json(cache.get(cacheKey));
  }

  // TMDB has no "sort by IMDb rating" endpoint (OMDb only does one-title lookups),
  // so this bootstraps from TMDB's own top-rated ranking (with a vote-count floor to
  // filter out tiny-sample outliers — lower for a single country's catalog, since even
  // well-known foreign titles get far fewer TMDB votes than English-language hits), then
  // cross-checks each one's real IMDb score via OMDb (by exact IMDb ID, not title text)
  // and keeps only the ones that clear the floor.
  const params = new URLSearchParams({
    api_key: TMDB_API_KEY,
    sort_by: 'vote_average.desc',
    'vote_count.gte': countryCode ? '50' : '1000',
    page: String(page)
  });
  if (countryCode) params.set('with_origin_country', countryCode);
  const tmdbRes = await fetch(`https://api.themoviedb.org/3/discover/movie?${params}`);
  if (!tmdbRes.ok) {
    return res.json({ results: [], reason: `TMDB request failed (${tmdbRes.status})` });
  }
  const data = await tmdbRes.json();
  const candidates = data.results || [];

  const enriched = await Promise.all(candidates.map(async (m) => {
    const t = await getTmdbDetails(m.id).catch(() => null);
    if (!t) return null;
    const imdb = await lookupOmdbForTmdb(t).catch(() => ({ rating: null }));
    if (!imdb.rating || parseFloat(imdb.rating) < IMDB_RATING_FLOOR) return null;
    const watch = await getWatchProviders(m.id).catch(() => ({ providers: [] }));
    return {
      id: t.id,
      title: t.title,
      year: t.year,
      country: t.country,
      director: t.director,
      cast: t.cast,
      posterUrl: t.posterThumbUrl,
      imdbRating: imdb.rating,
      providers: watch.providers
    };
  }));

  const results = enriched.filter(Boolean).sort((a, b) => parseFloat(b.imdbRating) - parseFloat(a.imdbRating));
  const result = { results, page, totalPages: data.total_pages || 1 };
  // As above: an empty page is far more likely to mean every OMDb call in this batch failed
  // (e.g. hit OMDb's free-tier daily cap) than that literally zero candidates clear the
  // rating floor, so don't let a transient failure get cached forever.
  if (results.length) cache.set(cacheKey, result);
  res.json(result);
});

app.get('/api/search-movies', async (req, res) => {
  const { q, lang } = req.query;
  if (!q || q.length < 2) {
    return res.json({ results: [] });
  }
  if (!TMDB_API_KEY) {
    return res.json({ results: [], reason: 'TMDB_API_KEY not configured' });
  }

  const params = new URLSearchParams({ api_key: TMDB_API_KEY, query: q });
  const tmdbRes = await fetch(`https://api.themoviedb.org/3/search/movie?${params}`);
  if (!tmdbRes.ok) {
    return res.json({ results: [], reason: `TMDB request failed (${tmdbRes.status})` });
  }
  const data = await tmdbRes.json();
  const candidates = (data.results || [])
    .filter((m) => !lang || m.original_language === lang)
    .slice(0, 6);

  const enriched = await Promise.all(candidates.map((m) => getTmdbDetails(m.id).catch(() => null)));
  res.json({ results: enriched.filter(Boolean) });
});

app.get('/api/movie-details', async (req, res) => {
  const { id, title, year } = req.query;
  if (!id && !title) {
    return res.status(400).json({ error: 'id or title query param is required' });
  }
  if (!TMDB_API_KEY) {
    return res.json({ tmdb: null, imdb: null, reason: 'TMDB_API_KEY not configured' });
  }

  let resolvedId = id;
  if (!resolvedId) {
    const { results, ok, status } = await searchTmdbMovie(title, year);
    if (!ok) {
      return res.json({ tmdb: null, imdb: null, reason: `TMDB search failed (${status})` });
    }
    const match = results[0];
    if (!match) {
      return res.json({ tmdb: null, imdb: null, reason: `No TMDB match found for "${title}"` });
    }
    resolvedId = match.id;
  }

  const t = await getTmdbDetails(resolvedId);
  if (!t) {
    return res.status(502).json({ tmdb: null, imdb: null, reason: 'TMDB detail request failed' });
  }
  const [imdb, watch] = await Promise.all([
    lookupOmdbForTmdb(t).catch((err) => ({ rating: null, reason: err.message })),
    getWatchProviders(resolvedId).catch(() => ({ providers: [], link: null }))
  ]);
  res.json({ tmdb: t, imdb, watch });
});

app.get('/api/health', (req, res) => {
  res.json({
    tmdbConfigured: Boolean(TMDB_API_KEY),
    omdbConfigured: Boolean(OMDB_API_KEY)
  });
});

// SPA shell with per-route Open Graph tags. Client-side routes like /country/thailand
// or /movie/parasite aren't real files — the front-end JS renders the actual view — but
// link-preview bots (Twitter/Discord/iMessage/etc.) only read the raw HTML we send back,
// so each route gets its own title/description/image injected server-side before that.
const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
const SITE_DESCRIPTION = 'Movie data by country — box office, budget, and international recognition, sourced honestly. Never invented, always verified.';

const COUNTRY_NAMES = {
  thailand: 'Thailand', 'south-korea': 'South Korea', japan: 'Japan',
  'united-states': 'United States', 'united-kingdom': 'United Kingdom', france: 'France',
  germany: 'Germany', italy: 'Italy', spain: 'Spain', iran: 'Iran',
  sweden: 'Sweden', denmark: 'Denmark', norway: 'Norway', finland: 'Finland'
};

const CURATED_MOVIES = {
  parasite: { title: 'Parasite', country: 'South Korea' },
  'how-to-make-millions-before-grandma-dies': { title: 'How to make millions before grandma dies', country: 'Thailand' }
};

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function resolveMovieMeta(slug) {
  if (CURATED_MOVIES[slug]) {
    const c = CURATED_MOVIES[slug];
    const poster = await lookupTmdbPoster(c.title).catch(() => ({ url: null }));
    return { title: c.title, country: c.country, image: poster.url };
  }
  if (slug.indexOf('tmdb:') === 0) {
    const t = await getTmdbDetails(slug.slice(5)).catch(() => null);
    return t ? { title: t.title, country: t.country, image: t.posterUrl } : null;
  }
  if (slug.indexOf('title:') === 0) {
    const parts = slug.slice(6).split('|');
    const title = decodeURIComponent(parts[0] || '');
    const year = parts[1] || '';
    if (!TMDB_API_KEY) return { title, country: null, image: null };
    const { results } = await searchTmdbMovie(title, year);
    const match = results[0];
    if (!match) return { title, country: null, image: null };
    const t = await getTmdbDetails(match.id).catch(() => null);
    return t ? { title: t.title, country: t.country, image: t.posterUrl } : { title, country: null, image: null };
  }
  return null;
}

app.get('*', async (req, res) => {
  const siteUrl = `${req.protocol}://${req.get('host')}`;
  let title = 'Houselights';
  let description = SITE_DESCRIPTION;
  let image = `${siteUrl}/og-default.png`;

  const countryMatch = req.path.match(/^\/country\/([^/]+)$/);
  const movieMatch = req.path.match(/^\/movie\/([^/]+)$/);

  if (countryMatch) {
    const name = COUNTRY_NAMES[decodeURIComponent(countryMatch[1])];
    if (name) {
      title = `${name} — Houselights`;
      description = `Box office leaders and internationally recognized films from ${name}, sourced honestly on Houselights.`;
    }
  } else if (movieMatch) {
    const meta = await resolveMovieMeta(decodeURIComponent(movieMatch[1])).catch(() => null);
    if (meta) {
      title = `${meta.title} — Houselights`;
      description = meta.country
        ? `${meta.country} — verified box office, budget, and international recognition on Houselights.`
        : SITE_DESCRIPTION;
      if (meta.image) image = meta.image;
    }
  }

  const html = INDEX_HTML
    .split('__OG_TITLE__').join(escapeHtml(title))
    .split('__OG_DESCRIPTION__').join(escapeHtml(description))
    .split('__OG_IMAGE__').join(image)
    .split('__OG_URL__').join(siteUrl + req.path);

  res.send(html);
});

app.listen(PORT, () => {
  console.log(`Houselights running at http://localhost:${PORT}`);
  if (!TMDB_API_KEY) console.log('  TMDB_API_KEY not set — posters will fall back to placeholders.');
  if (!OMDB_API_KEY) console.log('  OMDB_API_KEY not set — IMDb ratings will fall back to placeholders.');
});
