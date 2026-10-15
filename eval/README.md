# Prize-winner test set

The 2026 Fields Medal and Nobel Prize winners (`laureates.json`) are a fixed test set for the matcher.

`scripts/laureate_eval.py` runs after every data refresh (the `publish` job in
`.github/workflows/monthly-cdc-update.yml`). For each person it

1. looks up their OpenAlex author and ORCID iD (an author is accepted only when the name and the institution
   match; otherwise the person is reported as unresolved, never guessed). Pin a verified `openalex_id` or `orcid`
   in the manifest to override;
2. builds a profile from OpenAlex using the site's own `src/ai/openalexProfile.js` (`scripts/eval_profile.mjs`);
3. if `eval/cvs/<id>.pdf` exists (a CV or profile page saved from the person's university site), builds a second
   profile from it with the site's `quickProfile`, the same no-language-model path a resume takes;
4. embeds the profile with MiniLM, ranks the published vectors, and records the top 10 matches plus, for the top 5, the
   connections (closest research areas and papers, shared topics).

It writes `public/data/laureate_eval.json`. The site's Demo tab and the pass/fail marker read it. Pass rules are in the
file's `criteria` and in `scripts/laureate_eval.py` (`MIN_TOP_SCORE`, `PASS_RATIO`).

Run it by hand with `python scripts/laureate_eval.py` (needs network access to OpenAlex and Hugging Face, `node`, and the
published data in `public/data`). Offline tests: `python -m unittest discover scripts/tests`.

Sources are public only: ORCID and OpenAlex records, and public university pages for the CV PDFs. Economics (announced
Oct 12) can be added to `laureates.json`.
