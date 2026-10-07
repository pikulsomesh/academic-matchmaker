#!/usr/bin/env python3
"""Decide what a run of the data workflow should do; prints GitHub Actions outputs.

  manual run       -> whatever mode / per_institution was picked in the form
  monthly schedule -> cdc
  daily schedule,  -> no data published yet: a first full build at initial_per_institution;
  or a push that      then a full build at target_per_institution while the published index
  changes this file   is smaller and the website reads per-university files; otherwise skip
  or coverage.json    (finishes in seconds)

The daily build resumes from the previous day's cache, so a build too big for one day of
OpenAlex budget or one job's time limit completes over several days without anyone clicking.
"""

import argparse
import json
import os
import sys

# Standard library only: this runs before the pipeline's dependencies are installed.
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "public", "data")
COVERAGE_CONFIG = os.path.join(ROOT, "scripts", "config", "coverage.json")
SRC_DIR = os.path.join(ROOT, "src")
MONTHLY_CRON = "0 0 1 * *"


def read_json(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


def site_reads_shards(src_dir=SRC_DIR):
    """True once the website loads faculty_search.json (the per-university layout)."""
    for folder, _, files in os.walk(src_dir):
        for name in files:
            if name.endswith((".js", ".jsx", ".ts", ".tsx")):
                with open(os.path.join(folder, name), encoding="utf-8") as fh:
                    if "faculty_search.json" in fh.read():
                        return True
    return False


def tier_sizes(coverage):
    sizes = sorted({int(t["per_institution"]) for t in coverage.get("tiers") or []})
    return sizes or [int(coverage.get("target_per_institution", 200))]


def tier_for(coverage, per_institution):
    """Thresholds for a build of this size: the largest tier not above it (the first tier for small manual runs)."""
    tiers = sorted(coverage.get("tiers") or [], key=lambda t: t["per_institution"])
    chosen = tiers[0] if tiers else {}
    for tier in tiers:
        if tier["per_institution"] <= per_institution:
            chosen = tier
    return chosen


def site_reads_chunks(src_dir=SRC_DIR):
    """True once the website follows record_file to chunked full records (needed past the first tier)."""
    for folder, _, files in os.walk(src_dir):
        for name in files:
            if name.endswith((".js", ".jsx", ".ts", ".tsx")):
                with open(os.path.join(folder, name), encoding="utf-8") as fh:
                    if "record_file" in fh.read():
                        return True
    return False


def budget_mb(coverage, hosted=False):
    """Data size cap: hosted_size_budget_mb once the data is published to Hugging Face, else size_budget_mb
    (GitHub Pages' 1 GB site limit). Mirrors faculty.size_budget_mb()."""
    if hosted and coverage.get("hosted_size_budget_mb"):
        return coverage["hosted_size_budget_mb"]
    return coverage.get("size_budget_mb", 800)


def plan(event, schedule, mode_input, per_institution_input, metadata, coverage, shards_ready, chunks_ready=True,
         hosted=False):
    """-> (mode, per_institution, reason). mode is 'full', 'cdc' or 'skip'.

    hosted: the data is published to Hugging Face (bigger size budget)."""
    target = tier_sizes(coverage)[-1]
    if event == "workflow_dispatch":
        mode = mode_input or "cdc"
        return mode, int(per_institution_input or 200), f"manual {mode} run"
    if schedule == MONTHLY_CRON:
        return "cdc", target, "monthly update"
    if not metadata.get("last_ingestion"):
        # No real data published yet: a quick first build, so the site has data within a day.
        initial = int(coverage.get("initial_per_institution", 200))
        return "full", initial, f"first full build at {initial} per institution"
    built = int(metadata.get("per_institution") or 200)
    reached_at = metadata.get("size_budget_mb") or coverage.get("size_budget_mb", 800)
    if metadata.get("budget_reached") and budget_mb(coverage, hosted) <= reached_at:
        return "skip", built, "size budget reached; coverage stops growing"
    bigger = [size for size in tier_sizes(coverage) if size > built]
    if not bigger:
        return "skip", built, f"index already built at {built} per institution"
    if not shards_ready:
        return "skip", bigger[0], "waiting for the website to read per-university files"
    if bigger[0] > tier_sizes(coverage)[0] and not chunks_ready:
        return "skip", bigger[0], "waiting for the website to read chunked records (record_file)"
    return "full", bigger[0], f"expanding coverage from {built} to {bigger[0]} per institution"


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--event", default=os.environ.get("GITHUB_EVENT_NAME", ""))
    p.add_argument("--schedule", default="")
    p.add_argument("--mode", default="")
    p.add_argument("--per-institution", default="")
    args = p.parse_args(argv)
    mode, per_institution, reason = plan(
        args.event, args.schedule, args.mode, args.per_institution,
        read_json(os.path.join(DATA_DIR, "metadata.json")),
        read_json(COVERAGE_CONFIG),
        site_reads_shards(),
        site_reads_chunks(),
        hosted=bool(os.environ.get("HF_DATASET_REPO")),
    )
    print(f"Plan: {mode} ({reason})", file=sys.stderr)
    out = os.environ.get("GITHUB_OUTPUT")
    coverage = read_json(COVERAGE_CONFIG)
    tier = tier_for(coverage, per_institution)
    shards = max(1, int(coverage.get("ingest_shards", 50)))
    lines = (f"mode={mode}\nper_institution={per_institution}\n"
             f"min_works={tier.get('min_works', 20)}\nmin_citations={tier.get('min_citations', 500)}\n"
             f"min_h_index={tier.get('min_h_index', 10)}\nwindow_years={coverage.get('window_years', 10)}\n"
             f"size_budget_mb={budget_mb(coverage, bool(os.environ.get('HF_DATASET_REPO')))}\n"
             f"search_index_rows={coverage.get('search_index_rows', 100000)}\n"
             f"shards={shards}\nshard_list={json.dumps(list(range(shards)))}\n")
    if out:
        with open(out, "a", encoding="utf-8") as fh:
            fh.write(lines)
    else:
        print(lines, end="")


if __name__ == "__main__":
    main()
