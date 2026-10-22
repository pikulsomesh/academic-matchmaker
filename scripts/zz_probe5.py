import os, sys
sys.path.insert(0, os.path.dirname(__file__))
from openalex import OpenAlexClient
c = OpenAlexClient(per_second=8)
for q, cc in [("Universidad de Chile","CL"),("King Abdulaziz University","SA"),("Universitas Indonesia","ID"),("Universiti Teknologi Malaysia","MY"),("Queen's University Kingston","CA"),("Queen's University","CA")]:
    r = c.get("institutions", {"search": q, "filter": f"country_code:{cc}", "per-page": 6})
    for i in r["results"]:
        print("CAND", q, "|", i["id"].split("/")[-1], i["display_name"], i.get("type"), i.get("works_count"))
