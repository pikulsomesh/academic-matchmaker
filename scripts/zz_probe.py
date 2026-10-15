"""Temporary probe 2: where could emails come from? Same 50-person sample as probe 1, plus 200 more for rates."""
import json, os, random, re, sys
import requests
sys.path.insert(0, os.path.dirname(__file__))
from faculty import decode_search_file
import contacts
from huggingface_hub import hf_hub_download

S = requests.Session()
S.headers["User-Agent"] = "academic-matchmaker-probe (mailto:%s)" % (os.environ.get("OPENALEX_MAILTO") or "")
KEY = os.environ.get("OPENALEX_API_KEY")
def oa(path, **params):
    if KEY: params["api_key"] = KEY
    r = S.get("https://api.openalex.org/" + path, params=params, timeout=30); r.raise_for_status(); return r.json()

repo = os.environ.get("HF_DATASET_REPO") or "pikulsomesh/academic-matchmaker-data"
unis = {u["id"]: u for u in json.load(open(hf_hub_download(repo, "universities.json", repo_type="dataset")))}
rows = decode_search_file(json.load(open(hf_hub_download(repo, "faculty_search.json", repo_type="dataset"))))
random.seed(20261015)
sample = random.sample(rows, 50)
random.seed(7)
sample += random.sample([r for r in rows if not r.get("email")], 150)
EMAIL = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
def domains_for(u):
    from urllib.parse import urlparse
    h = urlparse(u.get("homepage_url") or "").hostname
    return {contacts.registered_domain(h)} if h else set()

stats = {"n": 0, "had_email": 0, "raw_aff_any_email": 0, "raw_aff_match": 0, "epmc_match": 0, "epmc_any": 0,
         "orcid": 0, "union_new": 0, "works_scanned": 0}
for n, r in enumerate(sample, 1):
    u = unis.get(r["institution_id"], {}); doms = domains_for(u)
    stats["n"] += 1; stats["had_email"] += bool(r.get("email"))
    # (b) OpenAlex raw affiliation strings on the author's last 3 years of works: one request, 50 works
    try:
        works = oa("works", filter=f"author.id:{r['id']},from_publication_date:2023-01-01", sort="publication_date:desc",
                   select="id,authorships,doi,ids", **{"per-page": 50})["results"]
    except Exception as ex:
        print("works error", ex); works = []
    stats["works_scanned"] += len(works)
    found_b, any_b = None, False
    for w in works:
        for a in w.get("authorships") or []:
            if ((a.get("author") or {}).get("id") or "").endswith(r["id"]):
                for s in a.get("raw_affiliation_strings") or []:
                    for e in EMAIL.findall(s):
                        any_b = True
                        e = e.lower().rstrip(".")
                        if not found_b and contacts.email_matches_institution(e, doms) and contacts.email_matches_name(e, r["name"]):
                            found_b = e
    stats["raw_aff_any_email"] += any_b; stats["raw_aff_match"] += bool(found_b)
    # (c) Europe PMC: author's papers by ORCID, core results carry full affiliations with emails
    a = oa(f"authors/{r['id']}", select="orcid")
    found_c, any_c = None, False
    if a.get("orcid"):
        stats["orcid"] += 1
        oid = a["orcid"].split("/")[-1]
        try:
            d = S.get("https://www.ebi.ac.uk/europepmc/webservices/rest/search",
                      params={"query": f'AUTHORID:"{oid}"', "resultType": "core", "format": "json", "pageSize": 25,
                              "sort": "P_PDATE_D desc"}, timeout=30).json()
            for res in (d.get("resultList") or {}).get("result") or []:
                for au in ((res.get("authorList") or {}).get("author") or []):
                    if ((au.get("authorId") or {}).get("value") or "") != oid:
                        continue
                    for aff in ((au.get("authorAffiliationDetailsList") or {}).get("authorAffiliation") or []):
                        for e in EMAIL.findall(aff.get("affiliation") or ""):
                            any_c = True
                            e = e.lower().rstrip(".")
                            if not found_c and contacts.email_matches_institution(e, doms) and contacts.email_matches_name(e, r["name"]):
                                found_c = e
        except Exception as ex:
            print("epmc error", ex)
    stats["epmc_any"] += any_c; stats["epmc_match"] += bool(found_c)
    if not r.get("email") and (found_b or found_c):
        stats["union_new"] += 1
    if n <= 50 or found_b or found_c:
        print(f"{n:3}. {r['name'][:30]:30} {u.get('name','')[:28]:28} had={r.get('email')} rawaff={found_b} ({any_b}) epmc={found_c} ({any_c}) works={len(works)}")
print("STATS", json.dumps(stats))
