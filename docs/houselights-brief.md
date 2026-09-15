# Houselights — Project Brief

## Concept
A movie-data site organized by country, showing box office, budget, admissions, and international recognition clearly — the things Box Office Mojo and The Numbers bury or don't show at all. Styled in cinema noir, not a cluttered spreadsheet.

## Core principle (this drives every design decision)
Never invent or pad data. When something can't be verified, the UI says so explicitly — that's a feature (see Iran, below), not a placeholder to fill in later.

## Identity
- Name: Houselights — the moment the lights come up after a screening and you find out what actually happened
- Palette: near-black background (#0c0c0e), surface #17171a, border #2a2a2f
- Accent: teal (#2dd4bf) for all interactive/data elements
- One exception: warm yellow (#f0c25e) is used only for "lights" in the wordmark, evoking incandescent house lights — not used anywhere else
- Type: Sora (bold sans-serif) throughout — no serif, that reads as "editorial," not noir
- Subtle film-grain texture overlay on the page background

## Confirmed country list (14 pages)
United States, Japan, United Kingdom, South Korea, France, Germany, Italy, Spain, Iran, Sweden, Denmark, Norway, Finland (Nordic countries as separate pages, not grouped). China and India were deliberately excluded — China for documented box-office data integrity issues, India for opaque budget/salary reporting. Thailand is built out first as the working example.

## Per-country page structure
Two tabs, not one blended score:
- **Box office leaders** — ranked only against that country's own industry, never against Hollywood imports
- **Internationally recognized** — built from verifiable facts only (Oscar submissions/shortlists, major festival official selections and awards), never an invented taste-based ranking

**Iran is a special case**: several of its most acclaimed films are banned domestically or made without state authorization; directors have been imprisoned for showing work at Cannes. The page should explain this plainly rather than show blank fields — it's informative, not a data gap.

## Movie page
Poster, IMDb score, recognition badges, **domestic box office (the movie's own local market, not the US)**, worldwide box office, budget, revenue-to-budget multiple (explicitly labeled "gross revenue, not profit" — this distinction matters, don't blur it), and a detailed awards section (submission year, category, result, significance).

## Home page
Seven tabs, each a real sourced top-20 with "View more" and honest gap notes where coverage is incomplete: This week's box office, All time box office, Highest IMDb scores, Best Picture (20yr), Palme d'Or (20yr), Golden Lion (Venice), Golden Bear (Berlin).

## Data sourcing for the real build
- **TMDB API** — free for non-commercial use (free account + key at themoviedb.org); commercial use needs a separate written agreement with TMDB. Use for posters, cast, basic metadata.
- **OMDb API** — free tier is 1,000 requests/day, small paid tiers above that. Use for IMDb ratings.
- Real IMDb data direct from IMDb is not realistically accessible (official API is ~$150K upfront plus metered usage) — TMDB/OMDb are the practical path, not a compromise.
- **KOFIC** (Korea's national film council) publishes unusually detailed, transparent admissions and profitability data — genuinely better than what's available for most countries, and a real edge given Korean fluency.
- No live per-country "top 20" source exists yet outside what's been manually researched for Thailand — every other country needs the same kind of research pass.

## What exists right now
A single-file HTML/CSS/JS prototype: home page, one fully built country page (Thailand, 23 verified box office entries + 9 verified internationally-recognized entries), one fully built movie page (*How to Make Millions Before Grandma Dies*), working click-through navigation, search autocomplete, and stylized (non-real) poster placeholders — real poster art needs the TMDB integration above, since API keys can't live safely in a static shareable file.

## Open questions, not yet decided
- Business model: ad-supported content vs. a B2B angle (Thai/Korean industry data licensing) — still unresolved, and they're different businesses
- "Internationally recognized" for Thailand is at 9 real entries, not the 20 originally hoped for — reaching further means researching smaller festivals (Locarno, Rotterdam, Busan), not lowering the bar for what counts
- Whether "this week's box office" should be live-refreshed data or a periodically updated snapshot
