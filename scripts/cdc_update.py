#!/usr/bin/env python3
"""Monthly change-data-capture update for public/data/faculty_index.json.

OpenAlex's `from_updated_date` filter needs a paid plan, so this works from publication
dates instead:
  1. Query every work whose publication_date is on or after the last run (minus an
     overlap window, because OpenAlex often indexes papers weeks after they appear) and
     that has an author at one of the tracked institutions.
  2. Match each work's authors against the index and merge new works into
     recent_publications (deduplicated by OpenAlex work id, newest first).
  3. Re-fetch every indexed author (100 per request) to refresh citation_count,
     h_index, works_count and the topic-derived primary_domain / domain_weights.
  4. Write the JSON files and stamp metadata.json with last_cdc_run = today.

Run build_search_index.py afterwards to refresh the embeddings.
"""

import argparse
import os
import re
import sys
from datetime import date, timedelta

from faculty import (AUTHOR_SELECT, apply_lab_signals, output_counts, DATA_DIR, WORK_SELECT, compute_domains, contact_flags, coverage_config,
                     merge_publications, last_publication_year, load_records, now_iso, publication_entry, read_json,
                     size_budget_mb, today_iso, write_json, write_records)
from openalex import MAX_OR_VALUES, OpenAlexClient, chunks, short_id


def log(*args):
    print(*args, file=sys.stderr, flush=True)


def fetch_new_works(client, institution_ids, since, until):
    for group in chunks(institution_ids, MAX_OR_VALUES):
        params = {
            "filter": f"authorships.institutions.id:{'|'.join(group)},"
                      f"from_publication_date:{since},to_publication_date:{until}",
            "select": WORK_SELECT,
        }
        yield from client.iterate("works", params)


def refresh_authors(client, author_ids):
    for group in chunks(author_ids, MAX_OR_VALUES):
        data = client.get("authors", {
            "filter": f"openalex:{'|'.join(group)}", "per-page": MAX_OR_VALUES, "select": AUTHOR_SELECT,
        })
        yield from data.get("results", [])


def run(data_dir, client, overlap_days=30, since=None, until=None):
    meta_path = os.path.join(data_dir, "metadata.json")
    records, universities = load_records(data_dir)
    meta = read_json(meta_path, {})
    if not meta.get("last_ingestion"):
        raise SystemExit("No metadata.json from a full ingestion yet (the repo still holds sample data). "
                         "Run initial_ingestion.py first, or the workflow with mode=full.")
    by_id = {r["id"]: r for r in records}

    until = until or today_iso()
    if since is None:
        last_run = meta.get("last_cdc_run") or meta.get("last_ingestion") or (date.today() - timedelta(days=31)).isoformat()
        since = (date.fromisoformat(last_run) - timedelta(days=overlap_days)).isoformat()
    institution_ids = sorted({u["id"] for u in universities if u.get("id")})
    log(f"Scanning works published {since}..{until} at {len(institution_ids)} institutions for {len(records)} faculty")

    new_by_author = {}
    scanned = 0
    for work in fetch_new_works(client, institution_ids, since, until):
        scanned += 1
        if not publication_entry(work)["title"]:
            continue
        for authorship in work.get("authorships") or []:
            author_id = short_id((authorship.get("author") or {}).get("id"))
            if author_id in by_id:
                new_by_author.setdefault(author_id, []).append(publication_entry(work, author_id))

    added = 0
    for author_id, entries in new_by_author.items():
        record = by_id[author_id]
        before = {p.get("id") for p in record.get("recent_publications", [])}
        record["recent_publications"] = merge_publications(record.get("recent_publications"), entries)
        apply_lab_signals(record, record["recent_publications"])
        added += sum(1 for p in record["recent_publications"] if p.get("id") not in before)

    refreshed = 0
    openalex_ids = [i for i in by_id if re.fullmatch(r"A\d+", i)]
    for author in refresh_authors(client, openalex_ids):
        record = by_id.get(short_id(author["id"]))
        if not record:
            continue
        record["citation_count"] = author.get("cited_by_count", record.get("citation_count", 0))
        record["works_count"] = author.get("works_count", record.get("works_count"))
        record["h_index"] = (author.get("summary_stats") or {}).get("h_index", record.get("h_index"))
        record["last_publication_year"] = last_publication_year(author) or record.get("last_publication_year")
        primary, weights = compute_domains(author.get("topics"))
        if weights:
            record["primary_domain"], record["domain_weights"] = primary, weights
        record.update(output_counts(author))
        record["flags"] = contact_flags(record)
        refreshed += 1

    coverage = coverage_config()
    budget_mb = size_budget_mb(coverage)
    stats = write_records(records, universities, data_dir,
                          budget_bytes=int(budget_mb * 1e6) if budget_mb else None,
                          search_index_rows=coverage.get("search_index_rows"))
    meta.update({
        "generated_at": now_iso(),
        "last_cdc_run": until,
        "last_cdc_window": {"from": since, "to": until},
        "last_cdc_stats": {
            "works_scanned": scanned,
            "faculty_with_new_works": len(new_by_author),
            "publications_added": added,
            "faculty_refreshed": refreshed,
            "openalex_requests": client.request_count,
        },
        "faculty_count": len(records),
        "pruned_for_size": stats["pruned"],
        "search_index_rows": stats["search_index_rows"],
        "search_index_complete": stats["search_index_complete"],
    })
    write_json(meta_path, meta)
    log(f"Scanned {scanned} works; {added} new publications for {len(new_by_author)} faculty; "
        f"refreshed {refreshed} author records ({client.request_count} OpenAlex requests).")
    return meta["last_cdc_stats"]


def main(argv=None, client=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--data-dir", default=DATA_DIR)
    p.add_argument("--overlap-days", type=int, default=30,
                   help="re-scan this many days before the last run to catch late-indexed works")
    p.add_argument("--since", help="override the start date (YYYY-MM-DD)")
    args = p.parse_args(argv)
    return run(args.data_dir, client or OpenAlexClient(), args.overlap_days, args.since)


if __name__ == "__main__":
    main()
