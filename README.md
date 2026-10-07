# Global Academic Matchmaker

A static React (Vite) single-page app, hosted on GitHub Pages, that helps prospective PhD and post-doc candidates find faculty at the top 100 global universities by research alignment.

> **Sample data:** `public/data/*.json` currently holds three placeholder faculty records (`example.edu` emails and profile links) that follow the target schema. They will be replaced by the ingestion pipeline in `scripts/`.

## Develop

```bash
npm install
npm run dev
npm run build   # outputs dist/
```

## Stack

- Vite + React, Tailwind CSS (MIT palette: `cardinal` #A31F34, `mit-gray` #8A8B8C, `charcoal` #231F20)
- lucide-react icons, FlexSearch, `@xenova/transformers` for in-browser AI

## Layout

```
.github/workflows/deploy.yml   build + deploy to GitHub Pages on push to main
scripts/                       data ingestion and monthly CDC update (Python)
public/data/                   universities.json, faculty_index.json, domains.json
src/components/                UI components
src/hooks/                     useFacultySearch, useLocalAI
```

## Deploy

Pushing to `main` runs `.github/workflows/deploy.yml`. In the repo's **Settings → Pages**, set **Source** to **GitHub Actions** once.

## Disclaimer

This application is a personal, independent open-source project. It is in no way affiliated with, endorsed by, sponsored by, or officially connected to the Massachusetts Institute of Technology (MIT) or any other academic institution listed herein.
