"""Temporary probe 3: QS 2026 ranks 101-200 from the published PDF, each matched to an OpenAlex institution."""
import io, os, re, sys, json
import requests
from pypdf import PdfReader

URL = "https://www.econ.muni.cz/do/econ/soubory/oddeleni/ozs/admissions/2026_QS_World_University_Rankings_1.2__For_qs.com__11.2025.pdf"
r = requests.get(URL, timeout=60, headers={"User-Agent": "Mozilla/5.0"})
print("PDF", r.status_code, len(r.content))
pages = PdfReader(io.BytesIO(r.content)).pages
text = "\n".join((p.extract_text() or "") for p in pages[:12])
open("qs_raw.txt", "w").write(text)
print("RAW-HEAD", text[:1500].replace("\n", " | "))
idx = text.find("101")
print("AROUND-101", text[max(0, idx - 300): idx + 1200].replace("\n", " | "))
