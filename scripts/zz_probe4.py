"""Temporary probe 4: QS 2026 ranks 101-200 -> config entries, each resolved to an OpenAlex institution, with eligible counts."""
import io, json, os, re, sys
import requests
from pypdf import PdfReader
sys.path.insert(0, os.path.dirname(__file__))
import initial_ingestion as ing
from openalex import OpenAlexClient, short_id

URL = "https://www.econ.muni.cz/do/econ/soubory/oddeleni/ozs/admissions/2026_QS_World_University_Rankings_1.2__For_qs.com__11.2025.pdf"
text = "\n".join((p.extract_text() or "") for p in PdfReader(io.BytesIO(requests.get(URL, timeout=60, headers={"User-Agent": "Mozilla/5.0"}).content)).pages[:14])
flat = re.sub(r"\s+", " ", text)
COUNTRIES = {
 "United States of America": "US", "United Kingdom": "GB", "China (Mainland)": "CN", "Hong Kong SAR, China": "HK", "Australia": "AU",
 "Germany": "DE", "Canada": "CA", "Japan": "JP", "Republic of Korea": "KR", "France": "FR", "Switzerland": "CH", "Singapore": "SG",
 "Netherlands": "NL", "Sweden": "SE", "Denmark": "DK", "Finland": "FI", "Norway": "NO", "Belgium": "BE", "Ireland": "IE", "Italy": "IT",
 "Spain": "ES", "Brazil": "BR", "Chile": "CL", "Mexico": "MX", "Argentina": "AR", "Colombia": "CO", "India": "IN", "Taiwan": "TW",
 "Malaysia": "MY", "Thailand": "TH", "Saudi Arabia": "SA", "Qatar": "QA", "United Arab Emirates": "AE", "Russian Federation": "RU",
 "New Zealand": "NZ", "Austria": "AT", "Israel": "IL", "Türkiye": "TR", "Turkey": "TR", "Egypt": "EG", "South Africa": "ZA",
 "Portugal": "PT", "Czech Republic": "CZ", "Poland": "PL", "Greece": "GR", "Indonesia": "ID", "Kazakhstan": "KZ", "Macau SAR, China": "MO",
 "Lebanon": "LB", "Pakistan": "PK", "Iran, Islamic Republic of": "IR", "Hungary": "HU", "Peru": "PE", "Iceland": "IS", "Luxembourg": "LU",
 "Estonia": "EE", "Lithuania": "LT", "Latvia": "LV", "Slovenia": "SI", "Cyprus": "CY", "Vietnam": "VN", "Bangladesh": "BD", "Jordan": "JO",
 "Kuwait": "KW", "Oman": "OM", "Croatia": "HR", "Serbia": "RS", "Ukraine": "UA", "Uruguay": "UY", "Ecuador": "EC", "Costa Rica": "CR",
}
names = sorted(COUNTRIES, key=len, reverse=True)
start = flat.index(" 101 University of Copenhagen")
end_m = re.search(r" 201 ", flat[start:])
chunk = flat[start: start + end_m.start()] if end_m else flat[start:start + 12000]
entries, unknown = [], []
for m in re.finditer(r"(?:(?<=\s)|^)(\d{3}) (.+?) (" + "|".join(re.escape(c) for c in names) + r")(?= \d{3} |$)", chunk + " 999 "):
    rank, name, country = int(m.group(1)), m.group(2).strip(), m.group(3)
    if 101 <= rank <= 200:
        entries.append({"rank": rank, "name": name, "country": country, "country_code": COUNTRIES[country]})
print("PARSED", len(entries), "last", entries[-1] if entries else None)
if len(entries) < 95:
    print("CHUNK-TAIL", chunk[-800:])

client = OpenAlexClient(per_second=8)
cache = ing.Cache(os.path.join(os.getcwd(), ".cache", "probe"), enabled=False)
out = []
for e in entries:
    short = re.sub(r"\s*\([^)]*\)", "", e["name"]).strip()
    alt = re.search(r"\(([^)]*)\)", e["name"])
    uni = {"rank": e["rank"], "name": short, "country_code": e["country_code"],
           "openalex_search": [short] + ([alt.group(1)] if alt and len(alt.group(1)) > 3 else []), "directories": []}
    try:
        inst = ing.resolve_institution(client, cache, uni)
    except Exception as ex:
        print("UNRESOLVED", e["rank"], short, ex); continue
    iid = short_id(inst["id"])
    uni["openalex_id"] = iid
    try:
        n = client.get("authors", {"filter": f"last_known_institutions.id:{iid},works_count:>19,cited_by_count:>499,summary_stats.h_index:>9", "per-page": 1})["meta"]["count"]
    except Exception as ex:
        n = -1
    overlap = ing._name_overlap(short, inst["display_name"])
    out.append(uni)
    print(f"{e['rank']:>3} {short[:42]:42} {e['country_code']} -> {iid:12} {inst['display_name'][:44]:44} {inst.get('type')} ov={overlap:.2f} eligible={n}")
    uni["_eligible"], uni["_matched"] = n, inst["display_name"]
json.dump(out, open("qs101_200.json", "w"))
print("JSON", json.dumps(out, ensure_ascii=False, separators=(",", ":")))
tot = sum(max(0, u["_eligible"]) for u in out)
print("TOTAL eligible (>=20 works, >=500 cites, h>=10)", tot, "capped at 1000:", sum(min(1000, max(0, u['_eligible'])) for u in out), "n", len(out))
