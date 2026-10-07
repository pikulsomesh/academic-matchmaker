"""Shared helpers for building faculty records in the blueprint schema."""

import json
import math
import os
import shutil
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


def last_publication_year(author):
    """Latest year with at least one work, from OpenAlex counts_by_year (about the last 10 years)."""
    years = [c.get("year") for c in author.get("counts_by_year") or [] if c.get("works_count")]
    return max(years) if years else None


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
SEARCH_SHARD_DIR = "search"
RECORD_CHUNK = 1000    # people per full-record file once a university is bigger than this
# Published bytes per person for each vector format (vectors/<n>.json): base64 data plus id and university.
VECTOR_BYTES = {"int8": 560, "bits": 84}
COVERAGE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config", "coverage.json")


def coverage_config():
    return read_json(COVERAGE_PATH, {}) or {}


def vector_format(coverage=None):
    """'bits' (1 bit per dimension, the default) or 'int8', from coverage.json vector_format."""
    fmt = (coverage if coverage is not None else coverage_config()).get("vector_format", "bits")
    return fmt if fmt in VECTOR_BYTES else "bits"


def size_budget_mb(coverage=None):
    """The data size cap: hosted_size_budget_mb while the data is published to Hugging Face
    (HF_DATASET_REPO set), else size_budget_mb (GitHub Pages' 1 GB site limit)."""
    coverage = coverage if coverage is not None else coverage_config()
    if os.environ.get("HF_DATASET_REPO") and coverage.get("hosted_size_budget_mb"):
        return coverage["hosted_size_budget_mb"]
    return coverage.get("size_budget_mb")


def shard_paths(institution_id):
    return (f"{FACULTY_SHARD_DIR}/{institution_id}.json", f"{EMBEDDING_SHARD_DIR}/{institution_id}.json")


def search_row(record, record_file=None):
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
        "last_publication_year": record.get("last_publication_year"),
        "record_file": record_file,
    }


def importance(record):
    """Ordering used to decide who stays when the data has to shrink: likely PIs and well-cited first."""
    return (record.get("seniority_score") or 0, record.get("citation_count") or 0)


def estimated_bytes(record):
    """What one person costs on disk: full record + one compact search row + vector.

    The global faculty_search.json repeats the top search_index_rows people (about 12 MB at 100k), which
    is small enough to leave out of a per-person estimate."""
    row = _compact_values(search_row(record), lambda _field, _value: 0)
    return (len(json.dumps(record, ensure_ascii=False, separators=(",", ":")))
            + len(json.dumps(row, ensure_ascii=False, separators=(",", ":"))) + VECTOR_BYTES[vector_format()])


# --- compact search files ------------------------------------------------------------------
#
# faculty_search.json and search/<institution id>.json hold one array per person instead of one object:
#   {"format": "compact-v1", "fields": [...SEARCH_FIELDS], "institutions": [ids], "domains": [names],
#    "record_files": [paths], "url_prefixes": [...], "rows": [[...], ...]}
# Row values follow `fields`; trailing nulls are dropped. institution_id, primary_domain, record_file and each
# entry of domains are indexes into the tables above; profile_url "<n>|rest" means url_prefixes[n] + rest.
# has_email is not stored (it is Boolean(email)). Decoded rows equal search_row() output.
# src/data/compactRows.js reads this format; keep the two in step.

SEARCH_FORMAT = "compact-v1"
SEARCH_FIELDS = ["id", "name", "title", "institution_id", "primary_domain", "domains", "citation_count", "email",
                 "profile_url", "seniority_score", "first_author_recent", "last_author_recent", "recent_works",
                 "last_publication_year", "record_file"]
URL_PREFIXES = ["https://orcid.org/", "https://openalex.org/"]
TABLE_OF = {"institution_id": "institutions", "primary_domain": "domains", "domains": "domains",
            "record_file": "record_files"}


def compact_url(url):
    for n, prefix in enumerate(URL_PREFIXES):
        if url.startswith(prefix):
            return f"{n}|{url[len(prefix):]}"
    return url


def _compact_values(row, index_of):
    """One search_row() as a compact-v1 array; index_of(field, value) -> table index."""
    values = []
    for field in SEARCH_FIELDS:
        value = row.get(field)
        if value is None or value == []:
            value = None
        elif field == "domains":
            value = [index_of(field, name) for name in value]
        elif field in TABLE_OF:
            value = index_of(field, value)
        elif field == "profile_url":
            value = compact_url(value)
        values.append(value)
    while values and values[-1] is None:
        values.pop()
    return values


def compact_search_file(rows):
    """search_row() dicts -> a compact-v1 file (see above)."""
    tables = {"institutions": [], "domains": [], "record_files": []}
    positions = {name: {} for name in tables}

    def index_of(field, value):
        name = TABLE_OF[field]
        if value not in positions[name]:
            positions[name][value] = len(tables[name])
            tables[name].append(value)
        return positions[name][value]

    encoded = [_compact_values(row, index_of) for row in rows]
    return {"format": SEARCH_FORMAT, "fields": SEARCH_FIELDS, **tables, "url_prefixes": URL_PREFIXES, "rows": encoded}


def decode_search_file(data):
    """compact-v1 file (or a plain list of rows) -> search_row() dicts."""
    if isinstance(data, list):
        return data
    tables = {name: data.get(name) or [] for name in ("institutions", "domains", "record_files")}
    prefixes = data.get("url_prefixes") or []
    rows = []
    for values in data["rows"]:
        row = {}
        for field, value in zip(data["fields"], values + [None] * (len(data["fields"]) - len(values))):
            if value is not None and field == "domains":
                value = [tables["domains"][i] for i in value]
            elif value is not None and field in TABLE_OF:
                value = tables[TABLE_OF[field]][value]
            elif value is not None and field == "profile_url" and "|" in value[:4]:
                n, rest = value.split("|", 1)
                value = prefixes[int(n)] + rest if n.isdigit() else value
            row[field] = value
        row["domains"] = row.get("domains") or []
        row["has_email"] = bool(row.get("email"))
        rows.append(row)
    return rows


def write_search_file(rows, path):
    """A compact-v1 search file, one person per line."""
    data = compact_search_file(rows)
    body = data.pop("rows")
    head = json.dumps(data, ensure_ascii=False, separators=(",", ":"))[:-1]
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(head + ',"rows":[\n')
        for i, values in enumerate(body):
            fh.write(json.dumps(values, ensure_ascii=False, separators=(",", ":")))
            fh.write(",\n" if i < len(body) - 1 else "\n")
        fh.write("]}\n")
    os.replace(tmp, path)


def prune_to_budget(records, budget_bytes):
    """Drop the least important people until the estimated data size fits. -> (kept, dropped_count)."""
    costs = {r["id"]: estimated_bytes(r) for r in records}
    total = sum(costs.values())
    if budget_bytes is None or total <= budget_bytes:
        return records, 0
    dropped = set()
    for record in sorted(records, key=importance):
        if total <= budget_bytes:
            break
        dropped.add(record["id"])
        total -= costs[record["id"]]
    return [r for r in records if r["id"] not in dropped], len(dropped)


def write_records(records, universities, data_dir, combined_limit=COMBINED_LIMIT,
                  budget_bytes=None, search_index_rows=None):
    """Write shards, the slim search index, universities.json, domains.json and (when small) faculty_index.json.

    budget_bytes: shrink the data to fit (least important people dropped first; `records` is updated in place).
    search_index_rows: faculty_search.json keeps only this many people (the most important); everyone
    is then also in search/<institution id>.json so the site can load one university's rows on demand.
    -> {"pruned", "faculty_count", "search_index_rows", "search_index_complete"}
    """
    for record in records:
        (record["first_author_recent"], record["last_author_recent"],
         record["recent_works"], record["seniority_score"]) = role_signals(record)
    records[:], pruned = prune_to_budget(records, budget_bytes)
    by_inst = {}
    for record in records:
        by_inst.setdefault(record["institution"].get("id"), []).append(record)
    os.makedirs(os.path.join(data_dir, FACULTY_SHARD_DIR), exist_ok=True)
    complete = search_index_rows is None or len(records) <= search_index_rows
    search_dir = os.path.join(data_dir, SEARCH_SHARD_DIR)
    if os.path.isdir(search_dir):
        shutil.rmtree(search_dir)
    if not complete:
        os.makedirs(search_dir)
    keep = set()
    file_of = {}
    for uni in universities:
        people = sorted(by_inst.get(uni["id"], []), key=importance, reverse=True)
        uni["embeddings_file"] = shard_paths(uni["id"])[1]
        uni["faculty_count"] = len(people)
        if len(people) <= RECORD_CHUNK:
            files = [shard_paths(uni["id"])[0]]
            write_faculty_index(people, os.path.join(data_dir, files[0]))
            keep.add(f"{uni['id']}.json")
        else:
            files = []
            shutil.rmtree(os.path.join(data_dir, FACULTY_SHARD_DIR, uni["id"]), ignore_errors=True)  # stale chunks
            for n, start in enumerate(range(0, len(people), RECORD_CHUNK)):
                path = f"{FACULTY_SHARD_DIR}/{uni['id']}/{n}.json"
                write_faculty_index(people[start:start + RECORD_CHUNK], os.path.join(data_dir, path))
                files.append(path)
            keep.add(uni["id"])
        for n, record in enumerate(people):
            file_of[record["id"]] = files[n // RECORD_CHUNK]
        uni["faculty_files"], uni["faculty_file"] = files, files[0]
        uni.pop("search_file", None)
        if not complete:
            uni["search_file"] = f"{SEARCH_SHARD_DIR}/{uni['id']}.json"
            write_search_file([search_row(r, file_of[r["id"]]) for r in people], os.path.join(data_dir, uni["search_file"]))
    shard_dir = os.path.join(data_dir, FACULTY_SHARD_DIR)
    for name in os.listdir(shard_dir):  # universities dropped from the config, or files that became chunks
        if name not in keep:
            full = os.path.join(shard_dir, name)
            shutil.rmtree(full) if os.path.isdir(full) else os.remove(full)

    top = records if complete else sorted(records, key=importance, reverse=True)[:search_index_rows]
    write_search_file([search_row(r, file_of[r["id"]]) for r in top], os.path.join(data_dir, "faculty_search.json"))
    write_json(os.path.join(data_dir, "universities.json"), universities)
    write_domains(records, os.path.join(data_dir, "domains.json"))
    combined = os.path.join(data_dir, "faculty_index.json")
    if len(records) <= combined_limit:
        write_faculty_index(records, combined)
    elif os.path.exists(combined):
        os.remove(combined)
    return {"pruned": pruned, "faculty_count": len(records), "search_index_rows": len(top),
            "search_index_complete": complete}


def load_records(data_dir):
    """All records, from the shards when present, else from faculty_index.json."""
    universities = read_json(os.path.join(data_dir, "universities.json"), [])
    if universities and all(u.get("faculty_file") for u in universities):
        records = []
        for uni in universities:
            for path in uni.get("faculty_files") or [uni["faculty_file"]]:
                records.extend(read_json(os.path.join(data_dir, path), []))
        return records, universities
    return read_json(os.path.join(data_dir, "faculty_index.json"), []), universities
