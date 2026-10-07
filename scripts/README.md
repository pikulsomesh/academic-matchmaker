# Data pipeline

Python 3.10+. `pip install -r scripts/requirements.txt`

| Script | What it does |
| --- | --- |
| `initial_ingestion.py` | Full rebuild of `public/data/` from OpenAlex, ORCID and faculty pages |
| `cdc_update.py` | Monthly update: new works since the last run, refreshed citations and domains |
| `build_search_index.py` | MiniLM embeddings for every faculty record (run after either script above) |

`.github/workflows/monthly-cdc-update.yml` runs `cdc_update.py` + `build_search_index.py` at
00:00 UTC on the 1st of each month, commits `public/data/`, then starts `deploy.yml`.
Run it by hand from the Actions tab with **mode = full** to do the first full ingestion
(a full run of 100 institutions takes a few hours; if it hits the job time limit, re-run it
and it resumes from its cache).

Set the repository secret `OPENALEX_API_KEY` (free at openalex.org/settings/api). OpenAlex bills
per request: without a key the daily budget is about 1,000 list calls, with a free key about
10,000. A full build uses roughly 3,000 to 4,000 calls and a monthly update roughly 1,000 to 1,500.
If the budget runs out mid-run, re-run the next day and it resumes from the cache.

## Where the data comes from

1. **Institutions**: `config/top100_qs2026.json` (QS World University Rankings 2026). Each is
   resolved to an OpenAlex institution; the id is written back to the config so you can check
   or pin it. `email_domains` (optional) adds accepted email domains beyond the homepage's.
2. **Faculty**: OpenAlex authors whose last known institution is that university, with at least
   20 works, 500 citations, h-index 10 and a paper in the last 3 years, most cited first, up to
   200 per institution (all adjustable by flags).
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

- `faculty_index.json`: array, one record per line. Blueprint schema plus `institution.id`,
  `h_index`, `works_count`, `orcid`, `profile_source`, `flags`, and `id`/`date` on each publication.
- `universities.json`: `[{id, name, country_code, rank, homepage_url, faculty_count}]`
- `domains.json`: sorted array of every domain name used in `primary_domain` / `domain_weights`.
- `metadata.json`: `generated_at`, `last_ingestion`, `last_cdc_run`, counts, last CDC stats.
- `faculty_embeddings.json`: see below.

## Embedding format

`faculty_embeddings.json` follows the contract read by `decodeEmbeddingIndex()` in `src/ai/vectors.js`:

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
