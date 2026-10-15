"""Temporary probe: institution ids, a 50-record sample audit, ORCID employment coverage."""
import json, os, random, re, sys
import requests
from bs4 import BeautifulSoup
sys.path.insert(0, os.path.dirname(__file__))
from faculty import decode_search_file

S = requests.Session()
S.headers["User-Agent"] = "academic-matchmaker-probe (mailto:%s)" % (os.environ.get("OPENALEX_MAILTO") or "")
KEY = os.environ.get("OPENALEX_API_KEY")
def oa(path, **params):
    if KEY: params["api_key"] = KEY
    r = S.get("https://api.openalex.org/" + path, params=params, timeout=30); r.raise_for_status(); return r.json()

print("=== INSTITUTIONS")
sel = "id,display_name,ror,country_code,type,works_count,cited_by_count,homepage_url,lineage,associated_institutions"
for q in ["University of Buenos Aires", "Universidad de Buenos Aires", "Osaka University", "Institute of Science Tokyo",
          "Science Tokyo", "Tokyo Institute of Technology", "Tokyo Medical and Dental University"]:
    for i in oa("institutions", search=q, **{"per-page": 6, "select": sel})["results"]:
        assoc = [(a["id"].split("/")[-1], a["display_name"], a.get("relationship")) for a in i.get("associated_institutions") or []][:6]
        print(f"{q!r:42} {i['id'].split('/')[-1]:12} {i['display_name'][:55]:55} {i['country_code']} {i['type']} works={i['works_count']} ror={i.get('ror')} home={i.get('homepage_url')} lineage={[x.split('/')[-1] for x in i.get('lineage') or []]} assoc={assoc}")
for iid in ["I3130568980", "I317356780", "I114531698"]:
    i = oa(f"institutions/{iid}", select=sel)
    print("CURRENT", iid, i["display_name"], i["country_code"], i["works_count"], i.get("homepage_url"))
# Authors with >=20 works and >=500 citations at each candidate, to compare sizes
def count(iid):
    return oa("authors", filter=f"last_known_institutions.id:{iid},works_count:>19,cited_by_count:>499", **{"per-page": 1})["meta"]["count"]
for q in ["University of Buenos Aires", "Osaka University", "Tokyo Institute of Technology", "Tokyo Medical and Dental University", "Institute of Science Tokyo"]:
    for i in oa("institutions", search=q, **{"per-page": 3, "select": "id,display_name,country_code"})["results"]:
        iid = i["id"].split("/")[-1]
        print("ELIGIBLE", q, iid, i["display_name"], i["country_code"], count(iid))

print("=== SAMPLE AUDIT")
from huggingface_hub import hf_hub_download
repo = os.environ.get("HF_DATASET_REPO") or "pikulsomesh/academic-matchmaker-data"
unis = json.load(open(hf_hub_download(repo, "universities.json", repo_type="dataset")))
meta = json.load(open(hf_hub_download(repo, "metadata.json", repo_type="dataset")))
print("META", json.dumps({k: v for k, v in meta.items() if not isinstance(v, (dict, list))}))
rows = decode_search_file(json.load(open(hf_hub_download(repo, "faculty_search.json", repo_type="dataset"))))
print("ROWS", len(rows), "with title", sum(1 for r in rows if r.get("title")), "with email", sum(1 for r in rows if r.get("email")))
byname = {u["id"]: u for u in unis}
random.seed(20261015)
sample = random.sample(rows, 50)
def page_text(url):
    try:
        r = S.get(url, timeout=20); 
        t = BeautifulSoup(r.text, "html.parser").get_text(" ", strip=True)
        return r.status_code, re.sub(r"\s+", " ", t)
    except Exception as e:
        return "ERR", str(e)[:100]
orcid_titles = 0; orcid_any = 0; orcid_n = 0
for n, r in enumerate(sample, 1):
    u = byname.get(r["institution_id"], {})
    a = oa(f"authors/{r['id']}", select="id,display_name,orcid,last_known_institutions,affiliations,works_count,cited_by_count,summary_stats")
    lki = [x["display_name"] for x in a.get("last_known_institutions") or []]
    affs = [(x["institution"]["display_name"], max(x["years"]) if x.get("years") else None) for x in (a.get("affiliations") or [])[:4]]
    print(f"\n--- {n}. {r['name']} | {u.get('name')} | title={r.get('title')!r} | email={r.get('email')} | profile={r.get('profile_url')}")
    print(f"    domain={r.get('primary_domain')} domains={r.get('domains')[:3]} cites={r.get('citation_count')} seniority={r.get('seniority_score')} last_author={r.get('last_author_recent')} last_pub={r.get('last_publication_year')}")
    print(f"    openalex lki={lki} affs={affs} h={(a.get('summary_stats') or {}).get('h_index')}")
    if r.get("profile_url") and "orcid.org" not in r["profile_url"] and "openalex.org" not in r["profile_url"]:
        code, t = page_text(r["profile_url"])
        last = r["name"].split()[-1]
        i = t.lower().find(last.lower())
        print(f"    PAGE {code} name_found={i >= 0} :: {t[max(0, i - 150): i + 350] if i >= 0 else t[:300]}")
    if a.get("orcid"):
        orcid_n += 1
        oid = a["orcid"].split("/")[-1]
        try:
            e = S.get(f"https://pub.orcid.org/v3.0/{oid}/employments", headers={"Accept": "application/json"}, timeout=20).json()
            emps = []
            for g in e.get("affiliation-group") or []:
                for s in g.get("summaries") or []:
                    es = s.get("employment-summary") or {}
                    end = es.get("end-date")
                    emps.append((es.get("organization", {}).get("name"), es.get("role-title"), es.get("department-name"),
                                 (es.get("start-date") or {}).get("year", {}).get("value") if es.get("start-date") else None,
                                 "current" if not end else (end.get("year") or {}).get("value")))
            cur = [x for x in emps if x[4] == "current"]
            if emps: orcid_any += 1
            if any(x[1] for x in cur): orcid_titles += 1
            print(f"    ORCID employments: {emps[:4]}")
        except Exception as ex:
            print("    ORCID error", ex)
print(f"\nORCID: {orcid_n} of 50 have ORCID; {orcid_any} list any employment; {orcid_titles} have a current role title")
