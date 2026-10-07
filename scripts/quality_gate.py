#!/usr/bin/env python3
"""Sanity-check a freshly built public/data before it is published, and write pipeline_status.json.

  snapshot  remember universities.json and metadata.json of the data about to be replaced
            (.cache/previous), so `check` can spot a build that lost people
  check     verify the new build; exit 1 when something is wrong so the workflow skips publishing

Checks: required files exist and parse; the search file decodes with unique ids; per-university
counts add up to metadata.json; every record_file exists; the vector index is consistent with the
people (cluster files, counts); nothing shrank by more than 20% against the snapshot (set
QUALITY_ALLOW_SHRINK=1 for an intentional shrink); the data fits the size budget.

On success pipeline_status.json is written into the data dir (it ships with the site), and a
report goes to .cache/quality_gate_report.{json,md} and $GITHUB_STEP_SUMMARY.
Standard library only.
"""

import argparse
import base64
import json
import os
import shutil
import sys

from faculty import DATA_DIR, decode_search_file, now_iso, read_json, write_json

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PREVIOUS_DIR = os.path.join(ROOT, ".cache", "previous")
REPORT_BASE = os.path.join(ROOT, ".cache", "quality_gate_report")
SNAPSHOT_FILES = ("universities.json", "metadata.json", "pipeline_status.json")
MAX_SHRINK = 0.20
MIN_PREVIOUS_FOR_UNI_CHECK = 50
SAMPLE_CLUSTERS = 5


def log(*args):
    print(*args, file=sys.stderr, flush=True)


def snapshot(data_dir, previous_dir=PREVIOUS_DIR):
    shutil.rmtree(previous_dir, ignore_errors=True)
    os.makedirs(previous_dir)
    for name in SNAPSHOT_FILES:
        src = os.path.join(data_dir, name)
        if os.path.exists(src):
            shutil.copy(src, os.path.join(previous_dir, name))
    log(f"Snapshot of the current data saved to {previous_dir}")


def dir_size_bytes(path):
    total = 0
    for folder, _, files in os.walk(path):
        for name in files:
            total += os.path.getsize(os.path.join(folder, name))
    return total


class Report:
    def __init__(self):
        self.errors, self.warnings, self.checks = [], [], []

    def ok(self, name):
        self.checks.append({"name": name, "ok": True})

    def fail(self, name, message):
        self.checks.append({"name": name, "ok": False, "message": message})
        self.errors.append(f"{name}: {message}")

    def warn(self, message):
        self.warnings.append(message)


def load(data_dir, name, report):
    path = os.path.join(data_dir, name)
    if not os.path.exists(path):
        report.fail("files", f"{name} is missing")
        return None
    try:
        return read_json(path, None)
    except (OSError, ValueError) as err:
        report.fail("files", f"{name} is unreadable: {err}")
        return None


def check_data(data_dir, previous_dir=PREVIOUS_DIR, budget_mb=None, allow_shrink=False):
    report = Report()
    universities = load(data_dir, "universities.json", report)
    meta = load(data_dir, "metadata.json", report)
    search = load(data_dir, "faculty_search.json", report)
    if report.errors:
        return report, {}
    report.ok("files")

    # Search file: decodes, unique ids.
    try:
        rows = decode_search_file(search)
    except Exception as err:  # any decode problem is a failed build
        report.fail("search_file", f"faculty_search.json does not decode: {err}")
        return report, {}
    ids = [r["id"] for r in rows]
    if not rows:
        report.fail("search_file", "faculty_search.json has no rows")
    elif len(set(ids)) != len(ids):
        report.fail("search_file", f"{len(ids) - len(set(ids))} duplicate ids in faculty_search.json")
    else:
        report.ok("search_file")

    # Counts and record files.
    total = sum(u.get("faculty_count") or 0 for u in universities)
    if meta.get("faculty_count") is not None and meta["faculty_count"] != total:
        report.fail("counts", f"universities.json adds up to {total} people but metadata.json says {meta['faculty_count']}")
    elif total == 0:
        report.fail("counts", "no people in any university")
    else:
        report.ok("counts")
    missing = [p for u in universities for p in (u.get("faculty_files") or [u.get("faculty_file")]) if p
               and not os.path.exists(os.path.join(data_dir, p))]
    if missing:
        report.fail("record_files", f"{len(missing)} record files are missing, e.g. {missing[0]}")
    else:
        report.ok("record_files")

    # Vector index.
    vectors = meta.get("vectors") or {}
    root = os.path.join(data_dir, "vectors")
    if not vectors or not os.path.exists(os.path.join(root, "centroids.json")):
        report.fail("vectors", "vector index missing (metadata.json vectors / vectors/centroids.json)")
    else:
        problem = None
        if vectors.get("count") != total:
            problem = f"vector index holds {vectors.get('count')} people, expected {total}"
        k = vectors.get("k") or 0
        for c in sorted({0, k - 1, *range(0, k, max(1, k // SAMPLE_CLUSTERS))})[:SAMPLE_CLUSTERS + 2] if k else []:
            path = os.path.join(root, f"{c}.json")
            if not os.path.exists(path):
                problem = problem or f"cluster file {c}.json is missing"
                break
            part = read_json(path, {})
            per = 48 if part.get("dtype") == "bits" else part.get("dim", 384)
            if len(base64.b64decode(part.get("data") or "")) != per * len(part.get("ids") or []):
                problem = problem or f"cluster {c}.json: vector bytes don't match its ids"
                break
        if problem:
            report.fail("vectors", problem)
        else:
            report.ok("vectors")

    # Shrinkage against the data being replaced.
    prev_unis = read_json(os.path.join(previous_dir, "universities.json"), [])
    prev_meta = read_json(os.path.join(previous_dir, "metadata.json"), {})
    prev_total = sum(u.get("faculty_count") or 0 for u in prev_unis)
    shrunk = []
    if prev_total and prev_meta.get("last_ingestion"):
        now = {u["id"]: u.get("faculty_count") or 0 for u in universities}
        for u in prev_unis:
            before = u.get("faculty_count") or 0
            if before >= MIN_PREVIOUS_FOR_UNI_CHECK and now.get(u["id"], 0) < before * (1 - MAX_SHRINK):
                shrunk.append(f"{u.get('name', u['id'])} {before}->{now.get(u['id'], 0)}")
        if total < prev_total * (1 - MAX_SHRINK):
            shrunk.insert(0, f"total {prev_total}->{total}")
    if shrunk and not allow_shrink:
        report.fail("shrink", "fewer people than the last build: " + "; ".join(shrunk[:5]) +
                    " (set QUALITY_ALLOW_SHRINK=1 if intended)")
    else:
        if shrunk:
            report.warn("Shrink allowed: " + "; ".join(shrunk[:5]))
        report.ok("shrink")

    # Size.
    size_mb = dir_size_bytes(data_dir) / 1e6
    if budget_mb and size_mb > budget_mb:
        report.fail("size", f"data is {size_mb:.0f} MB, over the {budget_mb:.0f} MB budget")
    else:
        report.ok("size")
    if meta.get("pruned_for_size"):
        report.warn(f"{meta['pruned_for_size']} lowest-ranked people were dropped to fit the size budget")

    # Contact coverage, for the status page only.
    with_email = sum(1 for r in rows if r.get("email"))
    summary = {"people": total, "size_mb": round(size_mb, 1), "with_email_in_search_file": with_email,
               "search_rows": len(rows), "previous_people": prev_total or None,
               "per_institution": {u["id"]: u.get("faculty_count") or 0 for u in universities}}
    return report, summary


def write_reports(report, summary, mode, run_url):
    result = "failed" if report.errors else "ok"
    body = {"result": result, "mode": mode, "checks": report.checks, "warnings": report.warnings,
            "errors": report.errors, "run_url": run_url, **{k: v for k, v in summary.items() if k != "per_institution"}}
    write_json(REPORT_BASE + ".json", body)
    lines = [f"## Data quality gate: {result}", ""]
    lines += [f"- {'✅' if c['ok'] else '❌'} {c['name']}" + (f": {c['message']}" if c.get("message") else "")
              for c in report.checks]
    lines += [f"- ⚠️ {w}" for w in report.warnings]
    if summary:
        lines += ["", f"{summary.get('people')} people, {summary.get('size_mb')} MB"]
    text = "\n".join(lines) + "\n"
    with open(REPORT_BASE + ".md", "w", encoding="utf-8") as fh:
        fh.write(text)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as fh:
            fh.write(text)
    return text


def write_status(data_dir, report, summary, mode, run_url, previous_dir=PREVIOUS_DIR):
    previous = read_json(os.path.join(previous_dir, "pipeline_status.json"), {})
    meta = read_json(os.path.join(data_dir, "metadata.json"), {})
    status = {
        "generated_at": meta.get("generated_at") or now_iso(),
        "last_success_at": now_iso(),
        "result": "ok",
        "mode": mode,
        "people": summary["people"],
        "size_mb": summary["size_mb"],
        "universities": len(summary["per_institution"]),
        "pruned_for_size": meta.get("pruned_for_size", 0),
        "last_cdc_run": meta.get("last_cdc_run"),
        "per_institution": summary["per_institution"],
        "warnings": report.warnings,
        "previous_success_at": previous.get("last_success_at"),
        "run_url": run_url,
    }
    write_json(os.path.join(data_dir, "pipeline_status.json"), status)
    return status


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("action", choices=["snapshot", "check"])
    p.add_argument("--data-dir", default=DATA_DIR)
    p.add_argument("--previous-dir", default=PREVIOUS_DIR)
    p.add_argument("--mode", default="")
    p.add_argument("--budget-mb", type=float, default=None)
    args = p.parse_args(argv)
    if args.action == "snapshot":
        snapshot(args.data_dir, args.previous_dir)
        return 0
    run_url = None
    if os.environ.get("GITHUB_RUN_ID") and os.environ.get("GITHUB_REPOSITORY"):
        run_url = f"{os.environ.get('GITHUB_SERVER_URL', 'https://github.com')}/{os.environ['GITHUB_REPOSITORY']}/actions/runs/{os.environ['GITHUB_RUN_ID']}"
    report, summary = check_data(args.data_dir, args.previous_dir, args.budget_mb,
                                 allow_shrink=os.environ.get("QUALITY_ALLOW_SHRINK") == "1")
    log(write_reports(report, summary, args.mode, run_url))
    if report.errors:
        return 1
    write_status(args.data_dir, report, summary, args.mode, run_url, args.previous_dir)
    return 0


if __name__ == "__main__":
    sys.exit(main())
