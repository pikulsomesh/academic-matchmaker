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
public/data/                   universities.json, faculty_index.json, domains.json
src/components/                UI components
src/hooks/                     useFacultySearch, useLocalAI
src/ai/                        model worker, document readers, prompts, vector math
```

## In-browser matching

Everything runs in the visitor's browser; uploads never leave the device.

1. Uploads become text: PDFs via pdf.js, screenshots via Tesseract OCR, saved HTML pages and text files directly.
2. `onnx-community/Qwen2.5-0.5B-Instruct` (4-bit ONNX, WebGPU when available, WASM otherwise) extracts research interests as JSON. Chat messages go through the same model and add to the profile.
3. `Xenova/all-MiniLM-L6-v2` embeds the profile, and faculty are ranked by cosine similarity.

Faculty vectors come from `public/data/faculty_embeddings.json` (written by `scripts/build_search_index.py`). Until that file exists, the app embeds the loaded faculty in the browser. File format:

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
