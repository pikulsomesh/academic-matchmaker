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

A full build runs as parallel jobs (`ingest_shards` in `config/coverage.json`, 50, at most 20 at a time),
each on its own few universities with its own cache; `assemble.py` merges their results and only then is
anything published. A shard that hits its time budget (270 minutes, with a hard stop 10 minutes later in case a
request hangs) or OpenAlex's daily limit ends as "paused" with its progress cached; nothing is published and the
next run, daily or manual, finishes it. A shard that fails for another reason stops the run without publishing. OpenAlex limits apply per key, so each of the
20 parallel jobs asks for 0.5 requests a second (about 10 a second in total); a 429 pauses the shard.

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
- `faculty/<institution id>.json`: that university's records, one per line (universities over 1,000 people are
  split into `faculty/<institution id>/<n>.json`, 1,000 per file, most important first; `universities.json`
  lists them as `faculty_files`, and every slim row carries `record_file`, the file holding its record). Blueprint schema plus
  `institution.id`, `h_index`, `works_count`, `orcid`, `profile_source`, `flags`, and `id`/`date`
  on each publication. Verified records first.
- `embeddings/<institution id>.json`: embeddings for the matching faculty file, same row order (format below).
- `faculty_search.json`: one slim row per faculty member, for search, facets and cards before a
  university's file is loaded: `{id, name, title, institution_id, primary_domain, domains (strongest first), citation_count, email, profile_url, has_email, seniority_score, first_author_recent, last_author_recent, recent_works, last_publication_year, record_file}`.
  Written compactly (about 100 bytes a person instead of about 500): `{format: "compact-v1", fields, institutions,
  domains, record_files, url_prefixes, rows}` where each row is an array in `fields` order (trailing nulls
  dropped), `institution_id` / `primary_domain` / `record_file` / each of `domains` index into the tables, a
  `profile_url` of `"<n>|rest"` is `url_prefixes[n] + rest`, and `has_email` is `Boolean(email)`.
  `faculty.write_search_file` writes it, `faculty.decode_search_file` and `src/data/compactRows.js` read it.
  `search/<institution id>.json` uses the same format.
- `domains.json`: sorted array of every domain name used in `primary_domain` / `domain_weights`.
- `metadata.json`: `generated_at`, `last_ingestion`, `last_cdc_run`, counts, last CDC stats.
- `faculty_index.json` + `faculty_embeddings.json`: the same data as single files. Written only while
  the index has at most 30,000 records (`COMBINED_LIMIT` in `faculty.py`) and deleted above that,
  since one file that large is too slow for the browser.

## Growing the database

`config/coverage.json` holds the plan. Each daily run builds the next tier in `tiers` (1,000, 3,000,
10,000, 25,000, 50,000 people per university) with looser thresholds each step (works, citations,
h-index), keeping anyone with a paper in the last `window_years` (10). Each record has
`last_publication_year`. Growth stops by itself when the data would pass `size_budget_mb` (800, under
GitHub Pages' 1 GB): the least important people (lowest `seniority_score`, then citations) are dropped
first and `metadata.budget_reached` turns on. When there are more than `search_index_rows` people
(100,000), `faculty_search.json` keeps only the most important of them and every university also gets
`search/<institution id>.json` (listed as `search_file` in `universities.json`) with all of its rows,
so the site loads one university's rows on demand. `metadata.json` records `search_index_complete`.

## Hosting the data on Hugging Face

With the repository variable `HF_DATASET_REPO` (e.g. `pikulsomesh/academic-matchmaker-data`) and the secret
`HF_TOKEN` (a write token) set, the workflow pulls the published data from that dataset before planning,
pushes `public/data` there after a build (`hf_sync.py`: one commit mirroring the folder, then a history squash),
and commits only `scripts/config`. The first run with an empty dataset seeds it with the current data even
when the plan skips. The size budget becomes `hosted_size_budget_mb` (8,000) instead of `size_budget_mb`.
`deploy.yml` then builds the site with `VITE_DATA_URL=https://huggingface.co/datasets/<repo>/resolve/main/`;
the site falls back to its bundled `public/data` while that URL doesn't answer. Without the variable and
secret nothing changes.

## Vector search at scale (`vectors/`)

`build_search_index.py` also writes an IVF index so the browser never needs every vector:
`vectors/centroids.json` (`{k, dim, dtype: "int8", scale: 127, model, data}`, about sqrt(N) k-means
centroids) and `vectors/<cluster>.json` (`{ids, institutions, institution_index (parallel to ids, indexes into institutions), dim,
dtype, data}`). Embed the query, rank the centroids, load the nearest clusters, rank those.
`metadata.vectors` = `{k, dim, model, count, dtype}`. Cluster vectors follow `vector_format` in
`config/coverage.json`: `"bits"` (default) keeps only the sign of each dimension, packed 8 per byte
(dimension i = byte i // 8, mask 0x80 >> (i % 8)), 48 bytes a person instead of 384; the browser scores them
against the full-precision query. `"int8"` keeps `scale: 127` int8 rows as before. Centroids stay int8.
`embeddings/<institution id>.json` is written until `src/` mentions `vectors/centroids.json`, then dropped.
Coverage beyond the first tier waits until `src/` mentions `record_file` (the site can read chunked full records).

## Role signals

OpenAlex affiliations include students and staff, so every record is a *researcher*, with a rough
guess at who leads a group. Each recent publication carries `position` (`first`, `middle`, `last`,
the author's place on the paper). Records get `first_author_recent` (did the work, can speak in
detail), `recent_works` (how many of those up to 5 papers have a known position), `last_author_recent` (usually the principal investigator, likely holds the funding) and
`seniority_score` 0-100: h-index, output and citations, plus the last-author share when positions
are known. It is recomputed on every write, so a monthly update fills it in for older data. It only
orders and badges people; nobody is dropped.

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
