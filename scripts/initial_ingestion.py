#!/usr/bin/env python3
"""Build public/data/{universities,faculty_index,domains,metadata}.json from scratch.

Pipeline, per institution in scripts/config/top100_qs2026.json:
  1. Resolve the institution in OpenAlex (pinned openalex_id, else name search).
  2. Pull its most-cited active authors (last_known_institutions = this institution).
  3. Fetch each author's most recent works.
  4. Find contact points: optional faculty-directory pages from the config, the author's
     public ORCID record (emails, personal/institutional URLs), and the institutional
     profile page itself, which is scraped for an (often obfuscated) email and a title.
  5. Write records in the blueprint schema; records missing an email or institutional
     profile link are kept but flagged, and sorted after fully verified ones.

Every network step is cached under .cache/ingestion/ so an interrupted run resumes.

Examples:
  python scripts/initial_ingestion.py                       # full run
  python scripts/initial_ingestion.py --institutions 3 --per-institution 20 --skip-scrape
"""

import argparse
import hashlib
import json
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from urllib.parse import urlparse

import requests

import contacts
from faculty import (AUTHOR_SELECT, DATA_DIR, apply_lab_signals, output_counts, MAX_RECENT_PUBLICATIONS, WORK_SELECT, compute_domains,
                     contact_flags, merge_publications, now_iso, publication_entry, read_json, today_iso,
                     verification_rank, write_json, write_records, last_publication_year)
from openalex import OpenAlexClient, RateLimited, RateLimiter, RequestCapReached, chunks, short_id

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG_PATH = os.path.join(ROOT, "scripts", "config", "top100_qs2026.json")
CACHE_DIR = os.path.join(ROOT, ".cache", "ingestion")
PAGE_HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; academic-matchmaker/1.0; +https://github.com/pikulsomesh/academic-matchmaker)"}
MAX_PAGE_BYTES = 3_000_000


class Cache:
    def __init__(self, root, enabled=True):
        self.root = root
        self.enabled = enabled

    def _path(self, kind, key):
        safe = hashlib.sha1(key.encode()).hexdigest()[:20]
        return os.path.join(self.root, kind, safe + ".json")

    def get(self, kind, key):
        path = self._path(kind, key)
        if self.enabled and os.path.exists(path):
            with open(path, encoding="utf-8") as fh:
                return json.load(fh)
        return None

    def put(self, kind, key, value):
        if not self.enabled:
            return value
        path = self._path(kind, key)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(value, fh)
        return value


def log(*args):
    print(*args, file=sys.stderr, flush=True)


# --- step 1: institutions --------------------------------------------------------------

def _name_overlap(a, b):
    ta, tb = set(contacts.name_tokens(a)), set(contacts.name_tokens(b))
    return len(ta & tb) / max(1, len(ta | tb))


def resolve_institution(client, cache, uni):
    select = "id,display_name,country_code,homepage_url,ror,works_count,type"
    if uni.get("openalex_id"):
        cached = cache.get("institution", uni["openalex_id"])
        if cached:
            return cached
        inst = client.get(f"institutions/{uni['openalex_id']}", {"select": select})
        return cache.put("institution", uni["openalex_id"], inst)
    key = f"{uni['name']}|{uni['country_code']}"
    cached = cache.get("institution-search", key)
    if cached:
        return cached
    best, best_score = None, -1.0
    for query in uni.get("openalex_search") or [uni["name"]]:
        data = client.get("institutions", {
            "search": query, "filter": f"country_code:{uni['country_code']}", "per-page": 5, "select": select,
        })
        for position, inst in enumerate(data.get("results", [])):
            score = _name_overlap(query, inst["display_name"]) * 2 - position * 0.1
            score += 0.5 if inst.get("type") == "education" else 0
            if score > best_score:
                best, best_score = inst, score
    if best is None:
        raise LookupError(f"No OpenAlex institution found for {uni['name']}")
    return cache.put("institution-search", key, best)


def institution_domains(uni, inst):
    domains = set(uni.get("email_domains") or [])
    if inst.get("homepage_url"):
        domains.add(contacts.registered_domain(urlparse(inst["homepage_url"]).hostname))
    return {d for d in domains if d}


# --- step 2: authors -------------------------------------------------------------------

def is_active(author, years=10):
    cutoff = date.today().year - years
    return sum(c.get("works_count", 0) for c in author.get("counts_by_year") or [] if c.get("year", 0) >= cutoff) > 0


def fetch_authors(client, cache, inst_id, args):
    key = f"{inst_id}|{args.min_works}|{args.min_citations}|{args.min_h_index}|{args.window_years}|{args.per_institution}"
    cached = cache.get("authors", key)
    if cached is not None:
        return cached
    params = {
        "filter": f"last_known_institutions.id:{inst_id},works_count:>{args.min_works - 1},cited_by_count:>{args.min_citations - 1}",
        "sort": "cited_by_count:desc",
        "select": AUTHOR_SELECT,
    }
    authors = []
    # Over-fetch so that filtering out inactive / low h-index authors still fills the quota.
    for author in client.iterate("authors", params, max_results=args.per_institution * 2):
        if (author.get("summary_stats") or {}).get("h_index", 0) < args.min_h_index or not is_active(author, args.window_years):
            continue
        authors.append(author)
        if len(authors) >= args.per_institution:
            break
    return cache.put("authors", key, authors)


# --- step 3: recent works --------------------------------------------------------------

def fetch_recent_works_batched(client, cache, author_ids, batch_size=25, months=18, max_pages=5):
    """Recent works for many authors with few requests (OpenAlex bills per request).

    One OR-filtered query per batch of authors, newest first; authors still short of
    MAX_RECENT_PUBLICATIONS after `max_pages` pages fall back to a per-author query.
    """
    result = {}
    todo = []
    for author_id in author_ids:
        cached = cache.get("works", author_id)
        if cached is not None:
            result[author_id] = cached
        else:
            todo.append(author_id)
    since = (date.today() - timedelta(days=months * 30)).isoformat()
    for batch in chunks(todo, batch_size):
        wanted = set(batch)
        found = {a: [] for a in batch}
        params = {
            "filter": f"author.id:{'|'.join(batch)},from_publication_date:{since},to_publication_date:{today_iso()}",
            "sort": "publication_date:desc",
            "select": WORK_SELECT,
        }
        for work in client.iterate("works", params, max_results=200 * max_pages):
            if not (work.get("title") or work.get("display_name") or "").strip():
                continue
            for authorship in work.get("authorships") or []:
                aid = short_id((authorship.get("author") or {}).get("id"))
                if aid in wanted and len(found[aid]) < MAX_RECENT_PUBLICATIONS:
                    found[aid].append(publication_entry(work, aid))
            if all(len(v) >= MAX_RECENT_PUBLICATIONS for v in found.values()):
                break
        for aid, pubs in found.items():
            if len(pubs) >= MAX_RECENT_PUBLICATIONS:
                result[aid] = cache.put("works", aid, pubs)
    for author_id in author_ids:
        if author_id not in result:
            result[author_id] = fetch_recent_works(client, cache, author_id)
    return result


def fetch_recent_works(client, cache, author_id):
    cached = cache.get("works", author_id)
    if cached is not None:
        return cached
    data = client.get("works", {
        "filter": f"author.id:{author_id},to_publication_date:{today_iso()}",
        "sort": "publication_date:desc",
        "per-page": MAX_RECENT_PUBLICATIONS,
        "select": WORK_SELECT,
    })
    pubs = [publication_entry(w, author_id) for w in data.get("results", [])]
    return cache.put("works", author_id, [p for p in pubs if p["title"]])


# --- step 4: contacts ------------------------------------------------------------------

class Web:
    def __init__(self, per_second=6):
        self.session = requests.Session()
        self.session.headers.update(PAGE_HEADERS)
        self.limiter = RateLimiter(per_second)

    def get_text(self, url, headers=None, timeout=20, max_seconds=45):
        """Page text, or None. `timeout` limits each socket wait; `max_seconds` caps the whole download so
        a server that drips bytes cannot stall a worker thread forever."""
        self.limiter.wait()
        try:
            resp = self.session.get(url, headers=headers, timeout=timeout, stream=True)
            if resp.status_code != 200:
                return None
            ctype = resp.headers.get("Content-Type", "")
            if headers is None and "html" not in ctype and "text" not in ctype:
                return None
            stop = time.monotonic() + max_seconds
            parts, size = [], 0
            for chunk in resp.iter_content(chunk_size=16384):
                parts.append(chunk)
                size += len(chunk)
                if size >= MAX_PAGE_BYTES or time.monotonic() > stop:
                    break
            resp.close()
            raw = b"".join(parts)[:MAX_PAGE_BYTES]
            try:
                return raw.decode(resp.encoding or "utf-8", errors="replace")
            except LookupError:  # a server sent a charset Python does not know (e.g. "ISO-8859-1.")
                return raw.decode("utf-8", errors="replace")
        except (requests.RequestException, ValueError):
            return None


def fetch_orcid(web, cache, orcid_url):
    orcid = orcid_url.rstrip("/").rsplit("/", 1)[-1]
    cached = cache.get("orcid", orcid)
    if cached is not None:
        return cached
    body = web.get_text(f"https://pub.orcid.org/v3.0/{orcid}/person", headers={"Accept": "application/json"})
    result = {"emails": [], "urls": []}
    if body:
        try:
            person = json.loads(body)
        except ValueError:
            person = {}
        for item in ((person.get("emails") or {}).get("email") or []):
            if item.get("email"):
                result["emails"].append(item["email"].lower())
        for item in ((person.get("researcher-urls") or {}).get("researcher-url") or []):
            value = ((item.get("url") or {}).get("value") or "").strip()
            if value.startswith("http"):
                result["urls"].append(value)
    return cache.put("orcid", orcid, result)


def scrape_profile(web, cache, url, name, domains):
    key = f"{url}|{name}"
    cached = cache.get("profile", key)
    if cached is not None:
        return cached
    body = web.get_text(url)
    result = contacts.scrape_profile_page(body, url, name, domains) if body else {"email": None, "title": None, "error": True}
    return cache.put("profile", key, result)


def load_directory(web, cache, directory):
    url = directory["url"] if isinstance(directory, dict) else directory
    selector = directory.get("item_selector") if isinstance(directory, dict) else None
    cached = cache.get("directory", f"{url}|{selector}")
    if cached is not None:
        return cached
    body = web.get_text(url)
    entries = contacts.scrape_directory_page(body, url, selector) if body else []
    log(f"    directory {url}: {len(entries)} entries")
    return cache.put("directory", f"{url}|{selector}", entries)


def find_contacts(author, uni, domains, directory_index, web, cache, args):
    name = author["display_name"]
    found = {"email": None, "profile_url": None, "profile_source": None, "title": None}

    entry = directory_index.get(contacts.name_key(name))
    if entry:
        found["email"] = entry.get("email")
        found["title"] = entry.get("title")
        if entry.get("profile_url"):
            found["profile_url"], found["profile_source"] = entry["profile_url"], "directory"

    orcid = fetch_orcid(web, cache, author["orcid"]) if author.get("orcid") and not args.skip_orcid else {"emails": [], "urls": []}
    if not found["profile_url"]:
        institutional = [u for u in orcid["urls"] if contacts.same_site(u, domains)]
        if institutional:
            found["profile_url"], found["profile_source"] = institutional[0], "orcid_researcher_url"

    if found["profile_url"] and not args.skip_scrape and (not found["email"] or not found["title"]):
        scraped = scrape_profile(web, cache, found["profile_url"], name, domains)
        found["email"] = found["email"] or scraped.get("email")
        found["title"] = found["title"] or scraped.get("title")

    if not found["email"]:
        for email in orcid["emails"]:
            if contacts.email_matches_institution(email, domains):
                found["email"] = email
                break

    if not found["profile_url"]:
        if author.get("orcid"):
            found["profile_url"], found["profile_source"] = author["orcid"], "orcid"
        else:
            found["profile_url"], found["profile_source"] = author["id"], "openalex"
    return found


# --- step 5: assemble ------------------------------------------------------------------

def build_record(author, uni, inst, recent, found):
    primary, weights = compute_domains(author.get("topics"))
    record = {
        "id": short_id(author["id"]),
        "name": author["display_name"],
        "title": found["title"],
        "email": found["email"],
        "profile_url": found["profile_url"],
        "institution": {
            "id": short_id(inst["id"]),
            "name": uni["name"],
            "country_code": uni["country_code"],
            "rank": uni["rank"],
        },
        "primary_domain": primary,
        "domain_weights": weights,
        "citation_count": author.get("cited_by_count", 0),
        "h_index": (author.get("summary_stats") or {}).get("h_index"),
        "works_count": author.get("works_count", 0),
        "orcid": author.get("orcid"),
        "recent_publications": merge_publications([], recent),
        "profile_source": found["profile_source"],
        "last_publication_year": last_publication_year(author),
    }
    apply_lab_signals(record, record["recent_publications"])
    record.update(output_counts(author))
    record["flags"] = contact_flags(record)
    return record


def parse_args(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--config", default=CONFIG_PATH)
    p.add_argument("--out-dir", default=DATA_DIR)
    p.add_argument("--institutions", type=int, default=None, help="only the first N institutions (testing)")
    p.add_argument("--per-institution", type=int, default=1000,
                   help="cap per institution; everyone passing the thresholds below is kept up to this")
    p.add_argument("--min-works", type=int, default=20)
    p.add_argument("--min-citations", type=int, default=500)
    p.add_argument("--min-h-index", type=int, default=10)
    p.add_argument("--window-years", type=int, default=10,
                   help="keep people with at least one paper in this many recent years")
    p.add_argument("--size-budget-mb", type=float, default=None,
                   help="shrink the data to this estimated size, dropping the least important people first")
    p.add_argument("--search-index-rows", type=int, default=None,
                   help="faculty_search.json keeps only this many people; search/<id>.json holds everyone")
    p.add_argument("--require-contact", action="store_true",
                   help="drop records with neither an email nor an institutional profile link")
    p.add_argument("--skip-orcid", action="store_true")
    p.add_argument("--skip-scrape", action="store_true", help="skip profile and directory page scraping")
    p.add_argument("--no-cache", action="store_true")
    p.add_argument("--workers", type=int, default=6)
    p.add_argument("--shard", default=None, metavar="I/N",
                   help="build only universities whose position in the list is I modulo N (parallel jobs)")
    p.add_argument("--partial-out", default=None,
                   help="write this shard's records to this file instead of the final data; assemble.py merges them")
    p.add_argument("--openalex-per-second", type=float, default=8)
    p.add_argument("--web-per-second", type=float, default=6)
    p.add_argument("--max-openalex-requests", type=int, default=None,
                   help="pause (exit 75, cache kept) after this many OpenAlex requests: this run's share of the daily budget")
    p.add_argument("--time-budget-minutes", type=float, default=None,
                   help="pause (exit 75, cache kept) once this much time has passed")
    return p.parse_args(argv)


EXIT_PAUSED = 75  # cache is saved; run again (next day if the OpenAlex budget ran out) to resume


class Paused(Exception):
    pass


def start_watchdog(args):
    """Hard stop: if the run is still going 10 minutes after its time budget (a hung request, say),
    exit as paused. Everything done so far is already in the cache, so the next run resumes."""
    if args.time_budget_minutes is None:
        return None
    def stop():
        log("Paused: the time budget passed and the run did not stop on its own; stopping now. Progress is cached.")
        os._exit(EXIT_PAUSED)
    timer = threading.Timer(args.time_budget_minutes * 60 + 600, stop)
    timer.daemon = True
    timer.start()
    return timer


def start_heartbeat(client, every=600):
    """Log OpenAlex request counts every few minutes, so a stalled shard shows up in the job log."""
    def beat():
        while True:
            time.sleep(every)
            log(f"... still running: {getattr(client, "request_count", 0)} OpenAlex requests so far, by status {dict(getattr(client, "status_counts", {}))}")
    threading.Thread(target=beat, daemon=True).start()


def main(argv=None, client=None, web=None):
    args = parse_args(argv)
    watchdog = start_watchdog(args)
    try:
        return build(args, client, web)
    except Paused as exc:
        log(f"Paused: {exc}. Progress is cached; run again to resume.")
        raise SystemExit(EXIT_PAUSED)
    except RequestCapReached as exc:
        log(f"Paused: {exc}, this run's share of the daily OpenAlex budget. Progress is cached; run again tomorrow to resume.")
        raise SystemExit(EXIT_PAUSED)
    except RateLimited as exc:
        log(f"Paused: OpenAlex asked us to wait {exc.retry_after:.0f}s (HTTP {exc.status}), so its budget is used up. "
            "Progress is cached; run again later to resume.")
        raise SystemExit(EXIT_PAUSED)
    except requests.HTTPError as exc:
        if exc.response is not None and exc.response.status_code == 429:
            log("Paused: OpenAlex daily budget used up. Progress is cached; run again tomorrow to resume.")
            raise SystemExit(EXIT_PAUSED)
        raise
    finally:
        if watchdog:
            watchdog.cancel()


def build(args, client=None, web=None):
    deadline = time.monotonic() + args.time_budget_minutes * 60 if args.time_budget_minutes is not None else None
    config = read_json(args.config)
    client = client or OpenAlexClient(per_second=args.openalex_per_second, max_requests=args.max_openalex_requests)
    start_heartbeat(client)
    web = web or Web(per_second=args.web_per_second)
    cache = Cache(CACHE_DIR, enabled=not args.no_cache)
    unis = config["universities"][: args.institutions] if args.institutions else config["universities"]
    if args.shard:
        index, count = (int(x) for x in args.shard.split("/"))
        unis = [u for position, u in enumerate(unis) if position % count == index]
        log(f"Shard {index}/{count}: {len(unis)} universities")

    universities, records = [], []
    config_updates = {}
    config_changed = False
    for uni in unis:
        if deadline is not None and time.monotonic() >= deadline:
            raise Paused("time budget reached")
        inst = resolve_institution(client, cache, uni)
        if not uni.get("openalex_id"):
            uni["openalex_id"] = short_id(inst["id"])
            config_updates[str(uni["rank"])] = uni["openalex_id"]
            config_changed = True
        domains = institution_domains(uni, inst)
        log(f"[{uni['rank']:>3}] {uni['name']} -> {inst['display_name']} ({short_id(inst['id'])}, {', '.join(sorted(domains)) or 'no domain'})")

        directory_index = {}
        if not args.skip_scrape:
            for directory in uni.get("directories") or []:
                for entry in load_directory(web, cache, directory):
                    directory_index.setdefault(contacts.name_key(entry["name"]), entry)

        authors = fetch_authors(client, cache, short_id(inst["id"]), args)

        recent_by_author = fetch_recent_works_batched(client, cache, [short_id(a["id"]) for a in authors])

        def process(author):
            if deadline is not None and time.monotonic() >= deadline:
                raise Paused("time budget reached")
            recent = recent_by_author[short_id(author["id"])]
            found = find_contacts(author, uni, domains, directory_index, web, cache, args)
            return build_record(author, uni, inst, recent, found)

        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            inst_records = list(pool.map(process, authors))
        if args.require_contact:
            inst_records = [r for r in inst_records
                            if r["email"] or (r["profile_url"] and "profile_not_institutional" not in r["flags"])]
        verified = sum(1 for r in inst_records if not r["flags"] or r["flags"] == ["missing_title"])
        log(f"      {len(inst_records)} faculty, {verified} with email + institutional profile")
        records.extend(inst_records)
        universities.append({
            "id": short_id(inst["id"]),
            "name": uni["name"],
            "country_code": uni["country_code"],
            "rank": uni["rank"],
            "homepage_url": inst.get("homepage_url"),
            "faculty_count": len(inst_records),
        })

    if args.partial_out:
        write_json(args.partial_out, {"universities": universities, "records": records,
                                      "config_updates": config_updates, "openalex_requests": client.request_count},
                   compact=True)
        log(f"Wrote partial result: {len(records)} faculty from {len(universities)} institutions "
            f"using {client.request_count} OpenAlex requests.")
        return records

    records = finalize(records, universities, args, config.get("source"), client.request_count)
    if config_changed and args.config == CONFIG_PATH and not args.institutions:
        write_json(args.config, config)
    return records


def finalize(records, universities, args, ranking_source, openalex_requests):
    """Merge duplicates, write all data files and metadata.json. -> the final record list."""
    # Faculty who list two tracked institutions appear once, under the better-ranked one.
    unique = {}
    for record in records:
        unique.setdefault(record["id"], record)
    records = sorted(unique.values(), key=lambda r: (verification_rank(r), r["institution"]["rank"], -r["citation_count"]))
    universities = sorted(universities, key=lambda u: u["rank"])

    stats = write_records(records, universities, args.out_dir,
                          budget_bytes=int(args.size_budget_mb * 1e6) if args.size_budget_mb else None,
                          search_index_rows=args.search_index_rows)
    with_email = sum(1 for r in records if r["email"])
    write_json(os.path.join(args.out_dir, "metadata.json"), {
        "generated_at": now_iso(),
        "last_ingestion": today_iso(),
        "last_cdc_run": today_iso(),
        "ranking_source": ranking_source,
        "faculty_count": len(records),
        "per_institution": args.per_institution,
        "window_years": args.window_years,
        "budget_reached": stats["pruned"] > 0,
        "size_budget_mb": args.size_budget_mb,
        "pruned_for_size": stats["pruned"],
        "search_index_rows": stats["search_index_rows"],
        "search_index_complete": stats["search_index_complete"],
        "faculty_with_email": with_email,
        "institution_count": len(universities),
        "openalex_requests": openalex_requests,
    })
    log(f"Wrote {len(records)} faculty ({with_email} with email) from {len(universities)} institutions "
        f"using {openalex_requests} OpenAlex requests.")
    return records


if __name__ == "__main__":
    main()
