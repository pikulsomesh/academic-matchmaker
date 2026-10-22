import os, sys
sys.path.insert(0, os.path.dirname(__file__))
from openalex import OpenAlexClient
c = OpenAlexClient(per_second=8)
for name, ror in [("Universidad de Chile","047gc3g35"),("Universitas Indonesia","0116zj450"),("King Abdulaziz Univ","02ma4wv74"),("UTM","026w31v75"),("Queens","02y72wh86")]:
    r = c.get("institutions", {"filter": f"ror:https://ror.org/{ror}", "per-page": 3})
    for i in r["results"]:
        iid = i["id"].split("/")[-1]
        n = c.get("authors", {"filter": f"last_known_institutions.id:{iid},works_count:>19,cited_by_count:>499,summary_stats.h_index:>9", "per-page": 1})["meta"]["count"]
        print("ROR", name, "|", iid, i["display_name"], i.get("country_code"), "eligible", n)
    if not r["results"]: print("ROR", name, "none")
