#!/usr/bin/env python3
"""Merge the partial results of the parallel ingestion jobs into the final data files.

Each job ran `initial_ingestion.py --shard I/N --partial-out partial-I.json`. This reads every
partial-*.json under --partials, checks that all N arrived, then writes public/data exactly as a
single-process `initial_ingestion.py` run would. Exit 75 (paused) when a shard is missing: that
shard hit its time budget, its progress is cached, and the next run finishes it.
"""

import argparse
import glob
import os
import sys

import initial_ingestion as ingestion
from faculty import read_json, write_json


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--partials", required=True, help="folder holding the partial-*.json files (searched recursively)")
    p.add_argument("--expect", type=int, required=True, help="number of shards that should have produced a partial")
    p.add_argument("--config", default=ingestion.CONFIG_PATH)
    p.add_argument("--out-dir", default=ingestion.DATA_DIR)
    p.add_argument("--per-institution", type=int, default=1000)
    p.add_argument("--window-years", type=int, default=10)
    p.add_argument("--size-budget-mb", type=float, default=None)
    p.add_argument("--search-index-rows", type=int, default=None)
    args = p.parse_args(argv)

    files = sorted(glob.glob(os.path.join(args.partials, "**", "partial-*.json"), recursive=True))
    if len(files) < args.expect:
        print(f"Paused: only {len(files)} of {args.expect} shards finished; the rest resume on the next run.",
              file=sys.stderr)
        raise SystemExit(ingestion.EXIT_PAUSED)

    universities, records, updates, requests_made = [], [], {}, 0
    for path in files:
        part = read_json(path, {})
        universities.extend(part.get("universities", []))
        records.extend(part.get("records", []))
        updates.update(part.get("config_updates", {}))
        requests_made += part.get("openalex_requests", 0)

    config = read_json(args.config, {})
    records = ingestion.finalize(records, universities, args, config.get("source"), requests_made)
    if updates and args.config == ingestion.CONFIG_PATH:
        for uni in config.get("universities", []):
            if not uni.get("openalex_id") and str(uni["rank"]) in updates:
                uni["openalex_id"] = updates[str(uni["rank"])]
        write_json(args.config, config)


if __name__ == "__main__":
    main()
