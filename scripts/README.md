# Data pipeline

Python 3.10+. `pip install -r scripts/requirements.txt`

| Script | What it does |
| --- | --- |
| `initial_ingestion.py` | Full rebuild of `public/data/` from OpenAlex, ORCID and faculty pages |
| `cdc_update.py` | Monthly update: new works since the last run, refreshed citations and domains |
| `build_search_index.py` | MiniLM embeddings for every faculty record (run after either script above) |

`.github/workflows/monthly-cdc-update.yml` (`scripts/plan_run.py` decides what each run does):

- **Monthly** (00:00 UTC on the 1st): `cdc_update.py` + `build_search_index.py`, commit `public/data/`, start `deploy.yml`.
- **Daily** (02:00 UTC), and on merges that change `scripts/plan_run.py` or `scripts/config/coverage.json`:
  if no real data is published yet, a first full build at `initial_per_institution` (now 1000). After that,
  it grows coverage toward `target_per_institution` (1000) while the published index was built with a
  smaller cap (`metadata.json` → `per_institution`) and the website reads the per-university files
  (`src/` references `faculty_search.json`). Otherwise it skips in seconds.
- **Manual**: Actions tab → Run workflow, for a CDC or full run whenever you like.

Full builds stop themselves after 270 minutes or when OpenAlex's daily budget runs out (exit code 75,
shown as a "paused" notice). Progress stays cached and the next run, daily or manual, resumes it.
Nothing is committed until a build finishes.

Set the repository secret `OPENALEX_API_KEY` (free at openalex.org/settings/api). OpenAlex bills
per request: without a key the daily budget is about 1,000 list calls, with a free key about
10,000. A full build uses roughly 3,000 to 4,000 calls and a monthly update roughly 1,000 to 1,500.
If the budget runs out mid-run, re-run the next day and it resumes from the cache.

## Where the data comes from

1. **Institutions**: `config/top100_qs2026.json` (QS World University Rankings 2026). Each is
   resolved to an OpenAlex institution; the id is written back to the config so you can check
   or pin it. `email_domains` (optional) adds accepted email domains beyond the homepage's.
2. **Faculty**: OpenAlex authors whose last known institution is that university, with at least
   20 works, 500 citations, h-index 10 and a paper in the last 3 years, most cited first. Everyone
   passing those thresholds is kept, up to `--per-institution` (script default 1000; the workflow
   uses 200 until the website reads the per-university files below).
3. **Domains**: from the author's OpenAlex topics. `domain_weights` = share of works per OpenAlex
   subfield (top 5); `primary_domain` = the OpenAlex field with the largest share.
4. **Contacts**, in order of preference:
   - faculty-directory pages listed under `directories` in the config
     (`"directories": ["https://…/people"]` or `[{"url": "…", "item_selector": ".person-card"}]`);
   - institutional URLs from the author's public ORCID record, scraped for email and title;
   - a public ORCID email on the institution's domain.

   Obfuscated emails (`[at]`, `(at)`, `{at}`, ` at `, and `[dot]`/` dot `) are normalized, and an
   email is only accepted when it matches the person's name and the institution's domain.
   When no institutional page is found, `profile_url` falls back to ORCID, then OpenAlex.

Records missing contact points are kept but flagged (`flags`: `missing_email`,
`missing_profile_url`, `profile_not_institutional`, `missing_title`) and sorted after fully
verified ones. `--require-contact` drops records with neither an email nor an institutional page.

## Output files (`public/data/`)

- `universities.json`: `[{id, name, country_code, rank, homepage_url, faculty_count, faculty_file, embeddings_file}]`
- `faculty/<institution id>.json`: that university's records, one per line. Blueprint schema plus
  `institution.id`, `h_index`, `works_count`, `orcid`, `profile_source`, `flags`, and `id`/`date`
  on each publication. Verified records first.
- `embeddings/<institution id>.json`: embeddings for the matching faculty file, same row order (format below).
- `faculty_search.json`: one slim row per faculty member, for search, facets and cards before a
  university's file is loaded: `{id, name, title, institution_id, primary_domain, domains (strongest first), citation_count, email, profile_url, has_email}`.
- `domains.json`: sorted array of every domain name used in `primary_domain` / `domain_weights`.
- `metadata.json`: `generated_at`, `last_ingestion`, `last_cdc_run`, counts, last CDC stats.
- `faculty_index.json` + `faculty_embeddings.json`: the same data as single files. Written only while
  the index has at most 30,000 records (`COMBINED_LIMIT` in `faculty.py`) and deleted above that,
  since one file that large is too slow for the browser.

## Embedding format

Every embeddings file (`embeddings/<id>.json` and `faculty_embeddings.json`) follows the contract read by `decodeEmbeddingIndex()` in `src/ai/vectors.js`:

```json
{"model": "Xenova/all-MiniLM-L6-v2", "dim": 384, "dtype": "int8", "scale": 127,
 "ids": ["A5029…", "…"], "data": "<base64: ids.length x 384 int8, row-major>"}
```

Vectors come from the `onnx/model.onnx` export (mean pooling, L2-normalized), stored as
`round(x * 127)`; row `i` belongs to `ids[i]`. The embedded text per faculty is built by
`faculty_text()` in `build_search_index.py` and must stay identical to `facultyEmbeddingText()`
in `src/ai/vectors.js`: `{title}. Research areas: {domains by weight, primary_domain first if
absent}. Recent work: {up to 10 titles joined by "; "}.`

## Tests

`python -m unittest discover scripts/tests` runs offline against recorded API shapes.
