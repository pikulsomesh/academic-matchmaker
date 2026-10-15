"""Temporary probe 2: how many people would get a title from ORCID employments, and how right is it?"""
import json, os, random, sys, time, collections
import requests
sys.path.insert(0, os.path.dirname(__file__))
from faculty import decode_search_file
import contacts
from huggingface_hub import hf_hub_download

repo = os.environ.get("HF_DATASET_REPO") or "pikulsomesh/academic-matchmaker-data"
unis = {u["id"]: u for u in json.load(open(hf_hub_download(repo, "universities.json", repo_type="dataset")))}
rows = decode_search_file(json.load(open(hf_hub_download(repo, "faculty_search.json", repo_type="dataset"))))
KEY = os.environ.get("OPENALEX_API_KEY")
S = requests.Session(); S.headers["User-Agent"] = "academic-matchmaker-probe"
random.seed(11)
sample = random.sample(rows, 600)
stats = collections.Counter(); roles = collections.Counter(); shown = 0
for r in sample:
    u = unis.get(r["institution_id"], {})
    try:
        a = S.get(f"https://api.openalex.org/authors/{r['id']}", params={"select": "orcid", **({"api_key": KEY} if KEY else {})}, timeout=30).json()
    except Exception:
        continue
    stats["n"] += 1
    stats["had_title"] += bool(r.get("title"))
    if not a.get("orcid"):
        continue
    stats["orcid"] += 1
    oid = a["orcid"].split("/")[-1]
    try:
        rec = S.get(f"https://pub.orcid.org/v3.0/{oid}/record", headers={"Accept": "application/json"}, timeout=30).json()
    except Exception:
        stats["orcid_err"] += 1; continue
    emps = contacts.parse_orcid_employments(rec)
    stats["any_employment"] += bool(emps)
    title, aff = contacts.employment_title(emps, [u.get("name", "")])
    stats[f"aff_{aff}"] += 1
    if title:
        stats["title"] += 1; stats["title_and_no_old"] += (not r.get("title"))
        roles[contacts.role_from_title(title)] += 1
        if shown < 60:
            shown += 1; print(f"{r['name'][:28]:28} | {u.get('name','')[:30]:30} | {title!r} -> {contacts.role_from_title(title)} | old={r.get('title')!r}")
    elif aff == "match" and shown < 90:
        shown += 1; print(f"NOTITLE {r['name'][:28]:28} | {u.get('name','')[:30]:30} | {[ (e['org'], e['role']) for e in emps if e['current']][:3]}")
print("STATS", dict(stats)); print("ROLES", dict(roles))
