require('dotenv').config();
const express = require('express');
const path = require('path');

const TMDB_API_KEY = process.env.TMDB_API_KEY;
const OMDB_API_KEY = process.env.OMDB_API_KEY;
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// In-memory cache so repeated page loads/searches don't burn API quota.
const cache = new Map();

async function lookupTmdbPoster(title, year) {
  if (!TMDB_API_KEY) {
    return { url: null, reason: 'TMDB_API_KEY not configured' };
  }
  const params = new URLSearchParams({ api_key: TMDB_API_KEY, query: title });
  if (year) params.set('year', year);
  const res = await fetch(`https://api.themoviedb.org/3/search/movie?${params}`);
  if (!res.ok) {
    return { url: null, reason: `TMDB request failed (${res.status})` };
  }
  const data = await res.json();
  const match = data.results && data.results[0];
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
  return { rating: data.imdbRating, imdbId: data.imdbID, source: 'omdb' };
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

  const [poster, imdb] = await Promise.all([
    lookupTmdbPoster(title, year).catch((err) => ({ url: null, reason: err.message })),
    lookupOmdbRating(title, year).catch((err) => ({ rating: null, reason: err.message }))
  ]);

  const result = { poster, imdb };
  cache.set(cacheKey, result);
  res.json(result);
});

// Poster-only lookup for row thumbnails — avoids burning OMDb's daily quota
// on rows where only the poster is displayed (rating is only needed on the movie page).
app.get('/api/poster', async (req, res) => {
  const { title, year } = req.query;
  if (!title) {
    return res.status(400).json({ error: 'title query param is required' });
  }
  const cacheKey = `poster:${title}::${year || ''}`;
  if (cache.has(cacheKey)) {
    return res.json(cache.get(cacheKey));
  }
  const poster = await lookupTmdbPoster(title, year).catch((err) => ({ url: null, reason: err.message }));
  cache.set(cacheKey, poster);
  res.json(poster);
});

// Fallback when TMDB doesn't return production_countries for a title.
const LANG_COUNTRY = {
  ko: 'South Korea', th: 'Thailand', ja: 'Japan', fr: 'France', de: 'Germany',
  it: 'Italy', es: 'Spain', fa: 'Iran', sv: 'Sweden', da: 'Denmark', no: 'Norway', fi: 'Finnish'
};

async function getTmdbDetails(id) {
  const cacheKey = `details:${id}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const params = new URLSearchParams({ api_key: TMDB_API_KEY, append_to_response: 'credits' });
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
    cast: cast.slice(0, 3).map((c) => c.name)
  };
  cache.set(cacheKey, result);
  return result;
}

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
    const params = new URLSearchParams({ api_key: TMDB_API_KEY, query: title });
    if (year) params.set('year', year);
    const searchRes = await fetch(`https://api.themoviedb.org/3/search/movie?${params}`);
    if (!searchRes.ok) {
      return res.json({ tmdb: null, imdb: null, reason: `TMDB search failed (${searchRes.status})` });
    }
    const searchData = await searchRes.json();
    const match = searchData.results && searchData.results[0];
    if (!match) {
      return res.json({ tmdb: null, imdb: null, reason: `No TMDB match found for "${title}"` });
    }
    resolvedId = match.id;
  }

  const t = await getTmdbDetails(resolvedId);
  if (!t) {
    return res.status(502).json({ tmdb: null, imdb: null, reason: 'TMDB detail request failed' });
  }
  const imdb = await lookupOmdbRating(t.title, t.year).catch((err) => ({ rating: null, reason: err.message }));
  res.json({ tmdb: t, imdb });
});

app.get('/api/health', (req, res) => {
  res.json({
    tmdbConfigured: Boolean(TMDB_API_KEY),
    omdbConfigured: Boolean(OMDB_API_KEY)
  });
});

app.listen(PORT, () => {
  console.log(`Houselights running at http://localhost:${PORT}`);
  if (!TMDB_API_KEY) console.log('  TMDB_API_KEY not set — posters will fall back to placeholders.');
  if (!OMDB_API_KEY) console.log('  OMDB_API_KEY not set — IMDb ratings will fall back to placeholders.');
});
