"""Shared helpers for building faculty records in the blueprint schema."""

import json
import math
import os
from collections import defaultdict
from datetime import date, datetime, timezone

from openalex import short_id

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "public", "data")
MAX_DOMAINS = 5
MAX_RECENT_PUBLICATIONS = 5

AUTHOR_SELECT = ",".join([
    "id", "display_name", "orcid", "works_count", "cited_by_count", "summary_stats",
    "last_known_institutions", "topics", "counts_by_year",
])
WORK_SELECT = "id,title,display_name,publication_year,publication_date,authorships"


def compute_domains(topics):
    """OpenAlex author topics -> (primary_domain, domain_weights).

    domain_weights are OpenAlex *subfields* (e.g. "Artificial Intelligence"), weighted by the
    share of the author's topic-tagged works in each, top MAX_DOMAINS kept. primary_domain is
    the OpenAlex *field* (e.g. "Materials Science") with the largest share.
    """
    subfield_counts = defaultdict(float)
    field_counts = defaultdict(float)
    for topic in topics or []:
        count = float(topic.get("count") or 0)
        subfield = (topic.get("subfield") or {}).get("display_name")
        field = (topic.get("field") or {}).get("display_name")
        if subfield:
            subfield_counts[subfield] += count
        if field:
            field_counts[field] += count
    total = sum(subfield_counts.values())
    if not total:
        return None, {}
    ranked = sorted(subfield_counts.items(), key=lambda kv: (-kv[1], kv[0]))[:MAX_DOMAINS]
    weights = {name: round(count / total, 2) for name, count in ranked if round(count / total, 2) > 0}
    primary = max(field_counts.items(), key=lambda kv: (kv[1], kv[0]))[0] if field_counts else None
    return primary, weights


def author_position(work, author_id):
    """'first' | 'middle' | 'last' for this author on the work, or None when unknown."""
    for authorship in work.get("authorships") or []:
        if short_id((authorship.get("author") or {}).get("id")) == author_id:
            return authorship.get("author_position")
    return None


def publication_entry(work, author_id=None):
    entry = {
        "id": short_id(work.get("id")),
        "title": (work.get("title") or work.get("display_name") or "").strip(),
        "year": work.get("publication_year"),
        "date": work.get("publication_date"),
    }
    position = author_position(work, author_id) if author_id else None
    if position:
        entry["position"] = position  # first author did the work; last author usually leads the group
    return entry


def role_signals(record):
    """-> (first_author_recent, last_author_recent, recent_works, seniority_score 0-100).

    recent_works is how many of the (up to 5) recent papers have a known author position.

    seniority_score estimates "likely faculty / principal investigator" from h-index, output,
    citations and, when known, how often the person is last author on recent papers. It only
    orders and badges people; nobody is dropped.
    """
    pubs = record.get("recent_publications") or []
    known = [p["position"] for p in pubs if p.get("position")]
    first, last = known.count("first"), known.count("last")
    h_index = record.get("h_index") or 0
    works = record.get("works_count") or 0
    cites = record.get("citation_count") or 0
    parts = [(0.4, min(h_index / 60, 1)), (0.25, min(math.log10(works + 1) / 3, 1)),
             (0.2, min(math.log10(cites + 1) / 5, 1))]
    if known:
        parts.append((0.15, last / len(known)))
    total = sum(w for w, _ in parts)
    return first, last, len(known), round(100 * sum(w * v for w, v in parts) / total)


def merge_publications(existing, new_entries, limit=MAX_RECENT_PUBLICATIONS):
    """Union by work id (falling back to title), newest first, capped at `limit`."""
    by_key = {}
    for pub in list(existing or []) + list(new_entries or []):
        if not pub.get("title"):
            continue
        key = pub.get("id") or pub["title"].lower()
        kept = by_key.setdefault(key, pub)
        if pub.get("position") and not kept.get("position"):
            kept["position"] = pub["position"]  # backfill the role on records built before it existed
    ordered = sorted(by_key.values(), key=lambda p: (p.get("date") or f"{p.get('year') or 0}-00-00"), reverse=True)
    return ordered[:limit]


def contact_flags(record):
    flags = []
    if not record.get("email"):
        flags.append("missing_email")
    if not record.get("profile_url"):
        flags.append("missing_profile_url")
    elif record.get("profile_source") in ("orcid", "openalex"):
        flags.append("profile_not_institutional")
    if not record.get("title"):
        flags.append("missing_title")
    return flags


def verification_rank(record):
    """Sort key: records with both verified contact points first."""
    has_email = bool(record.get("email"))
    has_profile = bool(record.get("profile_url")) and record.get("profile_source") not in ("orcid", "openalex")
    return (not (has_email and has_profile), not has_email, not has_profile)


def today_iso():
    return date.today().isoformat()


def now_iso():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def read_json(path, default=None):
    if not os.path.exists(path):
        return default
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def write_json(path, data, compact=False):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        if compact:
            json.dump(data, fh, ensure_ascii=False, separators=(",", ":"))
        else:
            json.dump(data, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    os.replace(tmp, path)


def write_faculty_index(records, path):
    """One record per line: compact for the browser, readable diffs for the monthly commits."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write("[\n")
        for i, record in enumerate(records):
            fh.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")))
            fh.write(",\n" if i < len(records) - 1 else "\n")
        fh.write("]\n")
    os.replace(tmp, path)


def write_domains(records, path):
    """domains.json: flat, alphabetical list of every domain_weights key in the index."""
    names = set()
    for record in records:
        names.update(record.get("domain_weights", {}).keys())
        if record.get("primary_domain"):
            names.add(record["primary_domain"])
    write_json(path, sorted(names))


# --- sharded output ---------------------------------------------------------------------
#
# public/data/faculty/<institution id>.json      full records for one university
# public/data/embeddings/<institution id>.json   embeddings for that file (faculty_embeddings contract)
# public/data/faculty_search.json                slim row per faculty member for search and facets
# universities.json carries faculty_file / embeddings_file for each university.
#
# The single-file faculty_index.json is still written while the index is small enough for
# the browser to download in one go (COMBINED_LIMIT), so the site keeps working until it
# reads the shards; above the limit it is removed rather than left stale.

FACULTY_SHARD_DIR = "faculty"
EMBEDDING_SHARD_DIR = "embeddings"
COMBINED_LIMIT = 30000


def shard_paths(institution_id):
    return (f"{FACULTY_SHARD_DIR}/{institution_id}.json", f"{EMBEDDING_SHARD_DIR}/{institution_id}.json")


def search_row(record):
    """Slim record for faculty_search.json: enough to search, filter, sort and draw a card."""
    return {
        "id": record["id"],
        "name": record["name"],
        "title": record.get("title"),
        "institution_id": record["institution"].get("id"),
        "primary_domain": record.get("primary_domain"),
        "domains": [name for name, _ in sorted((record.get("domain_weights") or {}).items(), key=lambda kv: -kv[1])],
        "citation_count": record.get("citation_count", 0),
        "email": record.get("email"),
        "profile_url": record.get("profile_url"),
        "has_email": bool(record.get("email")),
        "seniority_score": record.get("seniority_score"),
        "first_author_recent": record.get("first_author_recent"),
        "last_author_recent": record.get("last_author_recent"),
        "recent_works": record.get("recent_works"),
    }


def write_records(records, universities, data_dir, combined_limit=COMBINED_LIMIT):
    """Write shards, the slim search index, universities.json, domains.json and (when small) faculty_index.json."""
    by_inst = {}
    for record in records:
        (record["first_author_recent"], record["last_author_recent"],
         record["recent_works"], record["seniority_score"]) = role_signals(record)
        by_inst.setdefault(record["institution"].get("id"), []).append(record)
    os.makedirs(os.path.join(data_dir, FACULTY_SHARD_DIR), exist_ok=True)
    keep = set()
    for uni in universities:
        faculty_file, embeddings_file = shard_paths(uni["id"])
        uni["faculty_file"], uni["embeddings_file"] = faculty_file, embeddings_file
        uni["faculty_count"] = len(by_inst.get(uni["id"], []))
        write_faculty_index(by_inst.get(uni["id"], []), os.path.join(data_dir, faculty_file))
        keep.add(os.path.basename(faculty_file))
    shard_dir = os.path.join(data_dir, FACULTY_SHARD_DIR)
    for name in os.listdir(shard_dir):  # universities dropped from the config
        if name.endswith(".json") and name not in keep:
            os.remove(os.path.join(shard_dir, name))

    write_faculty_index([search_row(r) for r in records], os.path.join(data_dir, "faculty_search.json"))
    write_json(os.path.join(data_dir, "universities.json"), universities)
    write_domains(records, os.path.join(data_dir, "domains.json"))
    combined = os.path.join(data_dir, "faculty_index.json")
    if len(records) <= combined_limit:
        write_faculty_index(records, combined)
    elif os.path.exists(combined):
        os.remove(combined)


def load_records(data_dir):
    """All records, from the shards when present, else from faculty_index.json."""
    universities = read_json(os.path.join(data_dir, "universities.json"), [])
    if universities and all(u.get("faculty_file") for u in universities):
        records = []
        for uni in universities:
            records.extend(read_json(os.path.join(data_dir, uni["faculty_file"]), []))
        return records, universities
    return read_json(os.path.join(data_dir, "faculty_index.json"), []), universities
