# Global Academic Matchmaker

A static React (Vite) single-page app, hosted on GitHub Pages, that helps prospective PhD and post-doc candidates find faculty at the top 100 global universities by research alignment.

> **Sample data:** `public/data/*.json` currently holds three placeholder faculty records (`example.edu` emails and profile links) that follow the target schema. They will be replaced by the ingestion pipeline in `scripts/`.

## Develop

```bash
npm install
npm run dev
npm run build   # outputs dist/
npm test        # unit tests for the matching helpers
```

## Stack

- Vite + React, Tailwind CSS (MIT palette: `cardinal` #A31F34, `mit-gray` #8A8B8C, `charcoal` #231F20)
- lucide-react icons, FlexSearch, `@huggingface/transformers` (Transformers.js v4, successor to `@xenova/transformers`) for in-browser AI

## Layout

```
.github/workflows/deploy.yml   build + deploy to GitHub Pages on push to main
scripts/                       data ingestion and monthly CDC update (Python)
public/data/                   universities.json, faculty_search.json, faculty/, search/ and embeddings/ per university
src/components/                UI components
src/hooks/                     useFacultySearch, useLocalAI
src/data/facultyStore.js       loads the catalog, per-university records and embedding shards
src/ai/                        model worker, document readers, prompts, vector math
```

## In-browser matching

Everything runs in the visitor's browser; uploads never leave the device.

1. Uploads become text: PDFs via pdf.js, screenshots via Tesseract OCR, saved HTML pages and text files directly.
2. `onnx-community/Qwen2.5-0.5B-Instruct` (4-bit ONNX, WebGPU when available, WASM otherwise) extracts research interests as JSON. Chat messages go through the same model and add to the profile.
3. `Xenova/all-MiniLM-L6-v2` embeds the profile, and faculty are ranked by cosine similarity.

Search, filters and cards run on the slim `faculty_search.json`; a university's full records (`faculty/<id>.json`) load only when someone opens a profile. Faculty vectors come from `embeddings/<id>.json`, one shard per university (written by `scripts/build_search_index.py`). The matcher downloads only the shards for the universities the country and institution filters leave in view, or all of them when no filter is set, and keeps them as int8 in memory.

Large builds (`metadata.json` has `search_index_complete: false`) keep only the most important 100,000 people in `faculty_search.json`. Picking a country or university then loads those universities' `search/<id>.json` files (best-ranked first, up to 150,000 people) and merges them in, and a note above the results says what the search covers. Without a filter, the matcher ranks the best-ranked universities up to 100,000 people (about 50 MB of vectors) and loads the rows of any match outside the catalog. A row's optional `record_file` points at a chunk of full records to use instead of the whole university file. When `metadata.json` lists `vectors`, the matcher uses the clustered index instead: it ranks `vectors/centroids.json`, then downloads only the closest clusters (`vectors/<n>.json`, 24 to start, widening while a filter leaves too few people), so it covers everyone without downloading every vector. A picked university that still has its own `embeddings/<id>.json` uses that file, which is exact. Older builds with a single `faculty_index.json` / `faculty_embeddings.json` still work, and when no vectors are published the app embeds the loaded faculty in the browser. File format (each shard):

```json
{
  "model": "Xenova/all-MiniLM-L6-v2",
  "dim": 384,
  "dtype": "int8",
  "ids": ["A50293182", "..."],
  "data": "<base64 of ids.length x 384 values, row-major, little-endian>"
}
```

Vectors are mean pooled and L2 normalized; `int8` stores `round(x * 127)`, `float32` stores raw floats. Each faculty record is embedded from the text built by `facultyEmbeddingText` in `src/ai/vectors.js`:

```
{title}. Research areas: {domain_weights keys by weight desc (stable on ties), with primary_domain prepended if missing, joined by ", "}. Recent work: {first 10 recent_publications titles joined by "; "}.
```

Sections with no data are left out. The first visit downloads several hundred MB of model weights from the Hugging Face Hub; the browser caches them afterwards.

## Deploy

Pushing to `main` runs `.github/workflows/deploy.yml`. In the repo's **Settings → Pages**, set **Source** to **GitHub Actions** once.

## Disclaimer

This application is a personal, independent open-source project. It is in no way affiliated with, endorsed by, sponsored by, or officially connected to the Massachusetts Institute of Technology (MIT) or any other academic institution listed herein.
