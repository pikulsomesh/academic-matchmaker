#!/usr/bin/env python3
"""Laureate test: match the 2026 Fields Medal and Nobel Prize winners and record what comes back.

For every person in eval/laureates.json this looks up their ORCID iD and OpenAlex author, then runs
up to two paths through the matcher and writes public/data/laureate_eval.json, which the website's
Demo tab and its pass/fail marker read:

  openalex  profile from the ORCID / OpenAlex author (src/ai/openalexProfile.js, via eval_profile.mjs)
  resume    profile from eval/cvs/<id>.pdf (pypdf text -> src/ai/profile.js quickProfile), when the file exists

Each profile is embedded with the same MiniLM model as the faculty vectors and ranked against the
published vectors (per-university embeddings or the vectors/ clusters), as the site does. For the top
matches it also records the connections: which of the match's research areas and papers are closest to
the profile, and which profile topics appear in the match's work (the site's "why this match").

A run passes when a profile was built and the best match scores at least MIN_TOP_SCORE. The overall
marker is "passing" when at least PASS_RATIO of the runs that could be attempted pass. Whether the
laureate appears among their own matches (self_rank) is recorded but does not gate: the dataset only
covers faculty at the top 100 universities.

Needs network (OpenAlex), node, and the published data in public/data. Exit code is 0 even when the
marker says "failing" so a refresh still publishes; it is 1 only when the script itself crashes
(the workflow then writes status "error" through --on-crash).

  python scripts/laureate_eval.py [--data-dir public/data] [--manifest eval/laureates.json]
"""

import argparse
import base64
import json
import math
import os
import re
import subprocess
import sys
import tempfile

import numpy as np

from faculty import DATA_DIR, load_records, now_iso, read_json, write_json

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MANIFEST = os.path.join(ROOT, "eval", "laureates.json")
CV_DIR = os.path.join(ROOT, "eval", "cvs")
BRIDGE = os.path.join(ROOT, "scripts", "eval_profile.mjs")
OUTPUT_NAME = "laureate_eval.json"

TOP_MATCHES = 10
CONNECTIONS_FOR = 5
MIN_TOP_SCORE = 0.30
PASS_RATIO = 0.8
DIM = 384
BITS_SCALE = math.sqrt(2 / math.pi)
STOP = {"and", "the", "for", "with", "of", "in", "on", "to", "a", "an"}

CRITERIA = {
    "run_passes_when": f"a profile is built and the best match scores at least {MIN_TOP_SCORE}",
    "marker_passing_when": f"at least {int(PASS_RATIO * 100)}% of the runs that could be attempted pass",
    "not_gating": "self_rank (whether the person is among their own matches) and unresolved identities are reported, not scored",
}


def log(*args):
    print(*args, file=sys.stderr, flush=True)


# --- identity ----------------------------------------------------------------------------------

def short(openalex_id):
    return (openalex_id or "").rstrip("/").rsplit("/", 1)[-1] or None


def orcid_id(orcid):
    return (orcid or "").rstrip("/").rsplit("/", 1)[-1] or None


def ascii_fold(text):
    import unicodedata
    return unicodedata.normalize("NFKD", text or "").encode("ascii", "ignore").decode().lower()


def name_key(name):
    return re.sub(r"[^a-z ]", "", ascii_fold(name).replace(".", " ")).split()


def names_match(wanted, found):
    """Same last name and the same first initial ('Henri B. Kagan' ~ 'Henri Kagan' ~ 'H. B. Kagan')."""
    a, b = name_key(wanted), name_key(found)
    return bool(a and b and a[-1] == b[-1] and a[0][0] == b[0][0])


def resolve_identity(person, client):
    """-> {openalex_id, orcid, resolved_by, note}. Never guesses: no unique institution match -> unresolved."""
    if person.get("openalex_id") or person.get("orcid"):
        return {"openalex_id": person.get("openalex_id"), "orcid": person.get("orcid"), "resolved_by": "manifest", "note": None}
    data = client.get("/authors", {"search": person["name"], "per-page": 15,
                                    "select": "id,display_name,orcid,works_count,last_known_institutions"})
    pattern = re.compile(person.get("institution_match") or re.escape(person["institution"]), re.I)
    candidates = []
    for author in data.get("results", []):
        if not names_match(person["name"], author.get("display_name")):
            continue
        institutions = " ".join(i.get("display_name", "") for i in author.get("last_known_institutions") or [])
        if pattern.search(institutions) or pattern.search(ascii_fold(institutions)):
            candidates.append(author)
    if not candidates:
        return {"openalex_id": None, "orcid": None, "resolved_by": None,
                "note": f"No OpenAlex author named {person['name']} at {person['institution']}."}
    best = max(candidates, key=lambda a: a.get("works_count") or 0)
    note = f"{len(candidates)} candidates at the institution; took the one with most works." if len(candidates) > 1 else None
    return {"openalex_id": short(best["id"]), "orcid": orcid_id(best.get("orcid")), "resolved_by": "openalex-search", "note": note}


# --- profiles ----------------------------------------------------------------------------------

def bridge(*args):
    out = subprocess.run(["node", BRIDGE, *args], capture_output=True, text=True, timeout=180)
    try:
        return json.loads(out.stdout.strip().splitlines()[-1])
    except (IndexError, json.JSONDecodeError):
        return {"ok": False, "error": (out.stderr or "profile script gave no answer").strip()[:300]}


def pdf_text(path, max_pages=8):
    from pypdf import PdfReader
    reader = PdfReader(path)
    return "\n".join((page.extract_text() or "") for page in reader.pages[:max_pages])


def openalex_profile(identity):
    ref = identity.get("orcid") or identity.get("openalex_id")
    if not ref:
        return {"ok": False, "error": "no ORCID or OpenAlex id", "unattempted": True}
    return bridge("openalex", ref)


def resume_profile(person):
    path = os.path.join(CV_DIR, f"{person['id']}.pdf")
    if not os.path.exists(path):
        return {"ok": False, "error": "no CV PDF in eval/cvs", "unattempted": True}
    text = pdf_text(path)
    if len(text.strip()) < 200:
        return {"ok": False, "error": "the PDF has too little text (scanned?)"}
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False, encoding="utf-8") as fh:
        fh.write(text)
    try:
        return bridge("text", fh.name)
    finally:
        os.unlink(fh.name)


# --- ranking against the published vectors ----------------------------------------------------

def decode_rows(part):
    """One vector file -> (ids, unit-ish matrix as float32 rows, kind)."""
    raw = base64.b64decode(part["data"])
    ids = part["ids"]
    if part.get("dtype") == "bits":
        bits = np.unpackbits(np.frombuffer(raw, dtype=np.uint8).reshape(len(ids), DIM // 8), axis=1)
        return ids, (bits.astype(np.float32) * 2 - 1) / (math.sqrt(DIM) * BITS_SCALE)
    mat = np.frombuffer(raw, dtype=np.int8).reshape(len(ids), DIM).astype(np.float32)
    return ids, mat / np.maximum(np.linalg.norm(mat, axis=1, keepdims=True), 1e-9)


def load_vectors(data_dir):
    """Every published vector as (ids, matrix). Prefers the clusters the site reads, else the shards."""
    parts = []
    vectors_dir = os.path.join(data_dir, "vectors")
    if os.path.exists(os.path.join(vectors_dir, "centroids.json")):
        for name in os.listdir(vectors_dir):
            if name != "centroids.json" and name.endswith(".json"):
                parts.append(read_json(os.path.join(vectors_dir, name)))
    else:
        emb_dir = os.path.join(data_dir, "embeddings")
        if os.path.isdir(emb_dir):
            parts = [read_json(os.path.join(emb_dir, n)) for n in os.listdir(emb_dir) if n.endswith(".json")]
        elif os.path.exists(os.path.join(data_dir, "faculty_embeddings.json")):
            parts = [read_json(os.path.join(data_dir, "faculty_embeddings.json"))]
    ids, mats = [], []
    for part in parts:
        if part and part.get("ids"):
            i, m = decode_rows(part)
            ids.extend(i)
            mats.append(m)
    return ids, (np.vstack(mats) if mats else np.zeros((0, DIM), dtype=np.float32))


def words(text):
    return re.findall(r"[a-z0-9][a-z0-9-]+", (text or "").lower())


def shared_interests(interests, texts):
    haystack = {w for t in texts for w in words(t)}
    out = []
    for interest in interests:
        needed = [w for w in words(interest) if w not in STOP]
        if needed and all(w in haystack for w in needed):
            out.append(interest)
    return out


def connections(profile_vec, profile, record, encoder):
    """The evidence behind one match: closest research areas and papers, and profile topics found in their work."""
    weights = record.get("domain_weights") or {}
    areas = [n for n, _ in sorted(weights.items(), key=lambda kv: -kv[1])]
    if record.get("primary_domain") and record["primary_domain"] not in areas:
        areas.insert(0, record["primary_domain"])
    papers = [p for p in (record.get("recent_publications") or [])[:10] if p.get("title")]
    texts = areas + [p["title"] for p in papers]
    if not texts:
        return {"shared_interests": [], "areas": [], "papers": []}
    scores = encoder(texts) @ profile_vec
    area_scores = sorted(zip(areas, scores[:len(areas)]), key=lambda t: -t[1])[:3]
    paper_scores = sorted(zip(papers, scores[len(areas):]), key=lambda t: -t[1])[:3]
    return {
        "shared_interests": shared_interests(profile.get("interests") or [], texts),
        "areas": [{"name": n, "score": round(float(s), 3)} for n, s in area_scores],
        "papers": [{"title": p["title"], "year": p.get("year") or p.get("publication_year"), "score": round(float(s), 3)}
                   for p, s in paper_scores],
    }


def match_profile(profile, encoder, index, records_by_id, own_ids):
    ids, matrix = index
    vec = encoder([profile["embedding_text"]])[0]
    scores = matrix @ vec
    order = np.argsort(-scores)[:max(TOP_MATCHES, 50)]
    own = {i for i in own_ids if i}
    self_rank = next((rank + 1 for rank, row in enumerate(order) if ids[row] in own), None)
    matches = []
    for rank, row in enumerate(order[:TOP_MATCHES]):
        record = records_by_id.get(ids[row], {})
        entry = {"id": ids[row], "name": record.get("name"), "title": record.get("title"),
                 "institution": (record.get("institution") or {}).get("name"),
                 "score": round(float(scores[row]), 3), "is_self": ids[row] in own}
        if rank < CONNECTIONS_FOR and record:
            entry["connections"] = connections(vec, profile, record, encoder)
        matches.append(entry)
    return matches, self_rank


def run_one(profile, encoder, index, records_by_id, own_ids):
    if profile.get("unattempted"):
        return {"status": "skipped", "reason": profile["error"]}
    if not profile.get("ok"):
        return {"status": "failed", "error": profile.get("error")}
    matches, self_rank = match_profile(profile, encoder, index, records_by_id, own_ids)
    top = matches[0]["score"] if matches else 0
    ok = bool(matches) and top >= MIN_TOP_SCORE
    return {"status": "passed" if ok else "failed",
            "error": None if ok else f"best match scored {top}, below {MIN_TOP_SCORE}",
            "profile": {"interests": profile.get("interests") or [], "text": profile["embedding_text"][:600]},
            "top_score": top, "self_rank": self_rank, "matches": matches}


# --- whole run ---------------------------------------------------------------------------------

def summarize(entries):
    runs = [r for e in entries for r in e["runs"].values()]
    attempted = [r for r in runs if r["status"] in ("passed", "failed")]
    passed = sum(1 for r in attempted if r["status"] == "passed")
    unresolved = sum(1 for e in entries if not (e["identity"]["openalex_id"] or e["identity"]["orcid"]))
    ratio = passed / len(attempted) if attempted else None
    if not attempted:
        status = "not_run"
    else:
        status = "passing" if ratio >= PASS_RATIO else "failing"
    return status, {"people": len(entries), "runs_attempted": len(attempted), "runs_passed": passed,
                    "runs_skipped": len(runs) - len(attempted), "people_unresolved": unresolved,
                    "pass_ratio": None if ratio is None else round(ratio, 3)}


def run(data_dir, manifest_path, client, encoder, run_url=None):
    manifest = read_json(manifest_path)
    index = load_vectors(data_dir)
    base = {"generated_at": now_iso(), "run_url": run_url, "criteria": CRITERIA, "prizes_note": manifest.get("note"),
            "encoder": "Xenova/all-MiniLM-L6-v2 (ONNX fp32, Python); the site runs the q8 build of the same model",
            "profile_paths": {"openalex": "src/ai/openalexProfile.js", "resume": "src/ai/profile.js quickProfile; no language model is involved"}}
    if len(index[0]) == 0:
        return {**base, "status": "not_run", "reason": "No published vectors in the data directory yet.", "summary": {}, "entries": []}
    records, _ = load_records(data_dir)
    records_by_id = {r["id"]: r for r in records}
    meta = read_json(os.path.join(data_dir, "metadata.json"), {})
    entries = []
    for person in manifest["laureates"]:
        log(f"{person['name']}")
        try:
            identity = resolve_identity(person, client)
        except Exception as err:  # one failed lookup must not sink the run
            identity = {"openalex_id": None, "orcid": None, "resolved_by": None, "note": f"Lookup failed: {err}"}
        has_cv = os.path.exists(os.path.join(CV_DIR, f"{person['id']}.pdf"))
        own_ids = [identity["openalex_id"]]
        runs = {"openalex": run_one(openalex_profile(identity), encoder, index, records_by_id, own_ids),
                "resume": run_one(resume_profile(person), encoder, index, records_by_id, own_ids)}
        entries.append({k: person.get(k) for k in ("id", "name", "prize", "year", "citation", "institution")}
                       | {"identity": identity, "cv_pdf": f"eval/cvs/{person['id']}.pdf" if has_cv else None, "runs": runs})
    status, summary = summarize(entries)
    return {**base, "status": status, "summary": summary, "data_generated_at": meta.get("generated_at"), "entries": entries}


def main(argv=None, client=None, encoder=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--data-dir", default=DATA_DIR)
    p.add_argument("--manifest", default=MANIFEST)
    args = p.parse_args(argv)
    run_url = None
    if os.environ.get("GITHUB_RUN_ID") and os.environ.get("GITHUB_REPOSITORY"):
        run_url = f"{os.environ.get('GITHUB_SERVER_URL', 'https://github.com')}/{os.environ['GITHUB_REPOSITORY']}/actions/runs/{os.environ['GITHUB_RUN_ID']}"
    path = os.path.join(args.data_dir, OUTPUT_NAME)
    try:
        if client is None:
            from openalex import OpenAlexClient
            client = OpenAlexClient()
        if encoder is None:
            from build_search_index import MiniLMEncoder
            encoder = MiniLMEncoder()
        result = run(args.data_dir, args.manifest, client, encoder, run_url)
    except Exception as err:
        write_json(path, {"generated_at": now_iso(), "run_url": run_url, "status": "error", "reason": f"{type(err).__name__}: {err}",
                          "criteria": CRITERIA, "summary": {}, "entries": []})
        log(f"Laureate test crashed: {err}")
        return 1
    write_json(path, result)
    log(f"Laureate test: {result['status']} {result.get('summary')}")
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as fh:
            fh.write(f"## Laureate test: {result['status']}\n\n{json.dumps(result.get('summary'))}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
