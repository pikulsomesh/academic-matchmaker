"""Offline tests for the data pipeline. Run: python -m unittest discover scripts/tests"""

import base64
import json
import os
import pathlib
import shutil
import sys
import tempfile
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import build_search_index  # noqa: E402
import cdc_update  # noqa: E402
import contacts  # noqa: E402
import plan_run  # noqa: E402
import initial_ingestion  # noqa: E402
import faculty  # noqa: E402
from faculty import compute_domains, merge_publications  # noqa: E402
from openalex import OpenAlexClient  # noqa: E402

TOPICS_A = [
    {"display_name": "Battery materials", "count": 40,
     "subfield": {"display_name": "Materials Chemistry"}, "field": {"display_name": "Materials Science"}},
    {"display_name": "ML for materials", "count": 30,
     "subfield": {"display_name": "Artificial Intelligence"}, "field": {"display_name": "Computer Science"}},
    {"display_name": "Electrolytes", "count": 30,
     "subfield": {"display_name": "Materials Chemistry"}, "field": {"display_name": "Materials Science"}},
]


def author(aid, name, orcid=None, cites=5000, topics=TOPICS_A):
    return {
        "id": f"https://openalex.org/{aid}", "display_name": name, "orcid": orcid,
        "works_count": 120, "cited_by_count": cites, "summary_stats": {"h_index": 30},
        "last_known_institutions": [{"id": "https://openalex.org/I63966007"}],
        "topics": topics, "counts_by_year": [{"year": 2026, "works_count": 6}],
    }


def work(wid, title, date, author_ids):
    return {
        "id": f"https://openalex.org/{wid}", "title": title, "publication_year": int(date[:4]),
        "publication_date": date,
        "authorships": [{"author": {"id": f"https://openalex.org/{a}"}} for a in author_ids],
    }


class FakeOpenAlex(OpenAlexClient):
    """Answers the handful of query shapes the scripts send."""

    def __init__(self, authors, works, refreshed=None):
        super().__init__(mailto="", api_key="", per_second=1000)
        self.authors, self.works, self.refreshed = authors, works, refreshed or {}
        self.calls = []

    def get(self, path, params=None, retries=5):
        params = params or {}
        self.calls.append((path, dict(params)))
        self.request_count += 1
        flt = params.get("filter", "")
        if path == "institutions":
            return {"results": [
                {"id": "https://openalex.org/I999", "display_name": "Massachusetts General Hospital", "type": "healthcare"},
                {"id": "https://openalex.org/I63966007", "display_name": "Massachusetts Institute of Technology",
                 "type": "education", "homepage_url": "http://web.mit.edu/", "country_code": "US"},
            ]}
        if path == "authors" and flt.startswith("last_known_institutions.id"):
            return self._page(self.authors, params)
        if path == "authors" and flt.startswith("openalex:"):
            ids = flt.split(":", 1)[1].split("|")
            return {"results": [self.refreshed.get(i) or a for a in self.authors
                                for i in [a["id"].rsplit("/", 1)[-1]] if i in ids]}
        if path == "works" and flt.startswith("author.id:"):
            ids = set(flt.split(",")[0].split(":", 1)[1].split("|"))
            since = flt.split("from_publication_date:")[1].split(",")[0] if "from_publication_date" in flt else ""
            mine = sorted((w for w in self.works if w["publication_date"] >= since
                           and any(x["author"]["id"].rsplit("/", 1)[-1] in ids for x in w["authorships"])),
                          key=lambda w: w["publication_date"], reverse=True)
            if "cursor" in params:
                return self._page(mine, params)
            return {"results": mine[: params.get("per-page", 5)]}
        if path == "works" and flt.startswith("authorships.institutions.id"):
            since = flt.split("from_publication_date:")[1].split(",")[0]
            return self._page([w for w in self.works if w["publication_date"] >= since], params)
        raise AssertionError(f"unexpected request {path} {params}")

    @staticmethod
    def _page(items, params):
        """Two-item pages, so cursor pagination is exercised."""
        start = 0 if params.get("cursor") in ("*", None) else int(params["cursor"])
        end = start + 2
        return {"results": items[start:end], "meta": {"next_cursor": str(end) if end < len(items) else None}}


class FakeWeb:
    def __init__(self, pages):
        self.pages = pages

    def get_text(self, url, headers=None, timeout=20):
        return self.pages.get(url)


class FakeEncoder:
    """Deterministic stand-in for MiniLM: bag of hashed words, unit length."""

    def __call__(self, texts):
        out = np.zeros((len(texts), build_search_index.DIM), dtype=np.float32)
        for i, text in enumerate(texts):
            for word in text.lower().split():
                out[i, hash(word) % build_search_index.DIM] += 1
        return out / np.linalg.norm(out, axis=1, keepdims=True)


class PlanTests(unittest.TestCase):
    COVERAGE = {"initial_per_institution": 200, "target_per_institution": 1000}
    BUILT = {"last_ingestion": "2026-10-07", "per_institution": 200}

    def plan(self, event="schedule", schedule="0 2 * * *", metadata=None, shards_ready=True, mode="", per=""):
        return plan_run.plan(event, schedule, mode, per, self.BUILT if metadata is None else metadata,
                             self.COVERAGE, shards_ready)[:2]

    def test_daily_expands_only_when_safe(self):
        self.assertEqual(self.plan(), ("full", 1000))
        self.assertEqual(self.plan(shards_ready=False)[0], "skip", "site still reads the single file")
        self.assertEqual(self.plan(metadata={}), ("full", 200), "first build starts on its own")
        self.assertEqual(self.plan(event="push", schedule="", metadata={}), ("full", 200))
        self.assertEqual(self.plan(metadata={"last_ingestion": "x", "per_institution": 1000})[0], "skip", "done")

    def test_monthly_and_manual(self):
        self.assertEqual(self.plan(schedule="0 0 1 * *")[0], "cdc")
        self.assertEqual(self.plan(event="workflow_dispatch", mode="full", per=""), ("full", 200))
        self.assertEqual(self.plan(event="workflow_dispatch", mode="full", per="500"), ("full", 500))

    def test_site_check_reads_src(self):
        d = tempfile.mkdtemp()
        try:
            pathlib.Path(d, "a.js").write_text("fetch('faculty_index.json')")
            self.assertFalse(plan_run.site_reads_shards(d))
            pathlib.Path(d, "b.jsx").write_text("fetchJson('faculty_search.json')")
            self.assertTrue(plan_run.site_reads_shards(d))
        finally:
            shutil.rmtree(d)


class TierTests(unittest.TestCase):
    COVERAGE = {"initial_per_institution": 1000, "tiers": [
        {"per_institution": 1000, "min_works": 20}, {"per_institution": 3000, "min_works": 10},
        {"per_institution": 10000, "min_works": 5}]}

    def plan(self, built, **extra):
        meta = {"last_ingestion": "x", "per_institution": built, **extra}
        return plan_run.plan("schedule", "0 2 * * *", "", "", meta, self.COVERAGE, True)[:2]

    def test_steps_up_one_tier_a_day(self):
        self.assertEqual(self.plan(1000), ("full", 3000))
        self.assertEqual(self.plan(3000), ("full", 10000))
        self.assertEqual(self.plan(10000)[0], "skip")
        self.assertEqual(plan_run.plan("schedule", "0 2 * * *", "", "", {}, self.COVERAGE, True)[:2], ("full", 1000))

    def test_stops_when_size_budget_reached(self):
        self.assertEqual(self.plan(3000, budget_reached=True)[0], "skip")

    def test_thresholds_follow_the_tier(self):
        self.assertEqual(plan_run.tier_for(self.COVERAGE, 3000)["min_works"], 10)
        self.assertEqual(plan_run.tier_for(self.COVERAGE, 200)["min_works"], 20)


class SizeAndIndexTests(unittest.TestCase):
    def records(self, n):
        return [{"id": f"A{i}", "name": f"P{i}", "title": None, "email": None, "profile_url": None,
                 "institution": {"id": "I1", "rank": 1}, "primary_domain": "X", "domain_weights": {"X": 1.0},
                 "citation_count": i * 10, "h_index": i, "works_count": 50 + i, "recent_publications": []}
                for i in range(n)]

    def test_prunes_least_important_to_fit(self):
        recs = self.records(50)
        cost = faculty.estimated_bytes(recs[0])
        kept, dropped = faculty.prune_to_budget(recs, cost * 20)
        self.assertEqual(len(kept) + dropped, 50)
        self.assertLessEqual(len(kept), 21)
        self.assertIn("A49", {r["id"] for r in kept})
        self.assertNotIn("A0", {r["id"] for r in kept})

    def test_truncated_search_index_and_university_files(self):
        d = tempfile.mkdtemp()
        try:
            unis = [{"id": "I1", "name": "U", "country_code": "US", "rank": 1}]
            stats = faculty.write_records(self.records(30), unis, d, search_index_rows=10)
            self.assertFalse(stats["search_index_complete"])
            top = json.load(open(os.path.join(d, "faculty_search.json")))
            self.assertEqual(len(top), 10)
            self.assertEqual(json.load(open(os.path.join(d, "universities.json")))[0]["search_file"], "search/I1.json")
            self.assertEqual(len(json.load(open(os.path.join(d, "search", "I1.json")))), 30)
            stats = faculty.write_records(self.records(30), unis, d, search_index_rows=100)
            self.assertTrue(stats["search_index_complete"])
            self.assertFalse(os.path.exists(os.path.join(d, "search")))
            self.assertNotIn("search_file", json.load(open(os.path.join(d, "universities.json")))[0])
        finally:
            shutil.rmtree(d)


class ChunkAndVectorTests(unittest.TestCase):
    def test_big_university_gets_chunks_with_record_file(self):
        d = tempfile.mkdtemp()
        try:
            unis = [{"id": "I1", "name": "U", "country_code": "US", "rank": 1}]
            recs = SizeAndIndexTests().records(2500)
            faculty.write_records(recs, unis, d)
            uni = json.load(open(os.path.join(d, "universities.json")))[0]
            self.assertEqual(uni["faculty_files"], ["faculty/I1/0.json", "faculty/I1/1.json", "faculty/I1/2.json"])
            self.assertEqual(uni["faculty_file"], "faculty/I1/0.json")
            rows = json.load(open(os.path.join(d, "faculty_search.json")))
            by_id = {r["id"]: r["record_file"] for r in rows}
            self.assertEqual(by_id["A2499"], "faculty/I1/0.json", "most important first")
            self.assertEqual(by_id["A0"], "faculty/I1/2.json")
            self.assertEqual(len(faculty.load_records(d)[0]), 2500)
            faculty.write_records(recs[:500], unis, d)  # shrinks back to one file; stale chunks are removed
            self.assertEqual(sorted(os.listdir(os.path.join(d, "faculty"))), ["I1.json"])
            self.assertEqual(json.load(open(os.path.join(d, "faculty_search.json")))[0]["record_file"], "faculty/I1.json")
        finally:
            shutil.rmtree(d)

    def test_ivf_clusters_cover_everyone(self):
        d = tempfile.mkdtemp()
        try:
            rng = np.random.default_rng(1)
            vecs = rng.normal(size=(300, 384)).astype("float32")
            vecs /= np.linalg.norm(vecs, axis=1, keepdims=True)
            q = build_search_index.quantize(vecs)
            ids = [f"A{i}" for i in range(300)]
            info = build_search_index.build_ivf(ids, q, d, institution_ids=["I" + str(i % 3) for i in range(300)])
            self.assertEqual((info["k"], info["dim"], info["count"]), (17, 384, 300))
            cent = json.load(open(os.path.join(d, "vectors", "centroids.json")))
            self.assertEqual(len(base64.b64decode(cent["data"])), 17 * 384)
            seen = []
            for c in range(17):
                part = json.load(open(os.path.join(d, "vectors", f"{c}.json")))
                self.assertEqual(len(base64.b64decode(part["data"])), len(part["ids"]) * 384)
                self.assertEqual(len(part["institution_ids"]), len(part["ids"]))
                seen += part["ids"]
            self.assertEqual(sorted(seen), sorted(ids))
        finally:
            shutil.rmtree(d)

    def test_bigger_tiers_wait_for_the_site(self):
        cov = {"initial_per_institution": 1000, "tiers": [{"per_institution": 1000}, {"per_institution": 3000}]}
        meta = {"last_ingestion": "x", "per_institution": 1000}
        args = ("schedule", "0 2 * * *", "", "", meta, cov, True)
        self.assertEqual(plan_run.plan(*args, chunks_ready=False)[0], "skip")
        self.assertEqual(plan_run.plan(*args, chunks_ready=True)[:2], ("full", 3000))
        d = tempfile.mkdtemp()
        try:
            pathlib.Path(d, "a.js").write_text("row.record_file")
            self.assertFalse(plan_run.site_reads_chunks(d))
            pathlib.Path(d, "b.js").write_text("fetch('vectors/centroids.json')")
            self.assertTrue(plan_run.site_reads_chunks(d))
        finally:
            shutil.rmtree(d)


class PauseTests(unittest.TestCase):
    def test_time_budget_pauses_with_exit_75(self):
        tmp = tempfile.mkdtemp()
        try:
            config = os.path.join(tmp, "c.json")
            pathlib.Path(config).write_text(json.dumps({"universities": [
                {"rank": 1, "name": "MIT", "country_code": "US", "openalex_id": None}]}))
            with self.assertRaises(SystemExit) as ctx:
                initial_ingestion.main(["--config", config, "--out-dir", tmp, "--time-budget-minutes", "0", "--no-cache"],
                                       client=FakeOpenAlex([], []), web=FakeWeb({}))
            self.assertEqual(ctx.exception.code, initial_ingestion.EXIT_PAUSED)
            self.assertFalse(os.path.exists(os.path.join(tmp, "faculty_search.json")), "nothing written when paused")
        finally:
            shutil.rmtree(tmp)


class EmailTests(unittest.TestCase):
    def test_obfuscation_variants(self):
        cases = {
            "jane.doe [at] mit.edu": "jane.doe@mit.edu",
            "jane.doe(at)mit.edu": "jane.doe@mit.edu",
            "jane.doe {AT} cs.ox.ac.uk": "jane.doe@cs.ox.ac.uk",
            "jane.doe at mit.edu": "jane.doe@mit.edu",
            "j.smith [at] ethz [dot] ch": "j.smith@ethz.ch",
            "jane.doe at mit dot edu": "jane.doe@mit.edu",
            "Email: jane&#64;stanford.edu": "jane@stanford.edu",
        }
        for text, expected in cases.items():
            self.assertEqual(contacts.extract_emails(text), [expected], text)

    def test_prose_and_role_accounts_ignored(self):
        self.assertEqual(contacts.extract_emails("She is a professor at MIT. Write to info@mit.edu"), [])

    def test_directory_cards(self):
        page = """<main><div class='grid'>
          <div class='card'><h3>Rahul Kumar</h3><p>Professor of Physics</p><a href='/p/rk'>Rahul Kumar</a>
            <span>rkumar (at) mit.edu</span></div>
          <div class='card'><h3>Ana Silva</h3><a href='/p/as'>Profile</a><a href='mailto:asilva@mit.edu'>Email</a></div>
        </div></main>"""
        entries = contacts.scrape_directory_page(page, "https://physics.mit.edu/people")
        self.assertEqual([(e["name"], e["email"], e["profile_url"]) for e in entries], [
            ("Rahul Kumar", "rkumar@mit.edu", "https://physics.mit.edu/p/rk"),
            ("Ana Silva", "asilva@mit.edu", "https://physics.mit.edu/p/as"),
        ])
        self.assertEqual(entries[0]["title"], "Professor of Physics")

    def test_titles(self):
        self.assertEqual(contacts.extract_title("Jane Doe\nAssociate Professor of Materials Science and Engineering\nRoom 1"),
                         "Associate Professor of Materials Science and Engineering")


class EmbeddingTextTests(unittest.TestCase):
    def test_matches_browser_recipe(self):
        record = {"title": "Associate Professor of Chemistry", "primary_domain": "Materials Science",
                  "domain_weights": {"Materials Chemistry": 0.3, "Artificial Intelligence": 0.6},
                  "recent_publications": [{"title": "A"}, {"title": ""}, {"title": "B"}]}
        self.assertEqual(build_search_index.faculty_text(record),
                         "Associate Professor of Chemistry. Research areas: Materials Science, "
                         "Artificial Intelligence, Materials Chemistry. Recent work: A; B.")
        self.assertEqual(build_search_index.faculty_text({}), "")


class DomainTests(unittest.TestCase):
    def test_weights_and_primary(self):
        primary, weights = compute_domains(TOPICS_A)
        self.assertEqual(primary, "Materials Science")
        self.assertEqual(weights, {"Materials Chemistry": 0.7, "Artificial Intelligence": 0.3})

    def test_merge_publications_dedupes_and_orders(self):
        merged = merge_publications([{"id": "W1", "title": "Old", "year": 2024, "date": "2024-01-01"}],
                                    [{"id": "W2", "title": "New", "year": 2026, "date": "2026-05-01"},
                                     {"id": "W1", "title": "Old", "year": 2024, "date": "2024-01-01"}])
        self.assertEqual([p["id"] for p in merged], ["W2", "W1"])


class RoleSignalTests(unittest.TestCase):
    def test_position_and_score(self):
        work = {"id": "https://openalex.org/W1", "title": "T", "publication_year": 2026,
                "authorships": [{"author": {"id": "https://openalex.org/A1"}, "author_position": "first"},
                                {"author": {"id": "https://openalex.org/A2"}, "author_position": "last"}]}
        self.assertEqual(faculty.publication_entry(work, "A2")["position"], "last")
        self.assertNotIn("position", faculty.publication_entry(work))
        pi = {"h_index": 70, "works_count": 400, "citation_count": 90000,
              "recent_publications": [{"title": "a", "position": "last"}] * 4}
        student = {"h_index": 10, "works_count": 21, "citation_count": 600,
                   "recent_publications": [{"title": "a", "position": "first"}] * 4}
        self.assertEqual(faculty.role_signals(pi)[:2], (0, 4))
        self.assertEqual(faculty.role_signals(student)[:2], (4, 0))
        self.assertGreater(faculty.role_signals(pi)[3], faculty.role_signals(student)[3] + 40)
        self.assertEqual(faculty.role_signals({"h_index": 10})[:2], (0, 0))  # positions unknown: no crash

    def test_merge_backfills_position(self):
        old = [{"id": "W1", "title": "T", "date": "2026-01-01"}]
        new = [{"id": "W1", "title": "T", "date": "2026-01-01", "position": "last"}]
        self.assertEqual(merge_publications(old, new)[0]["position"], "last")


class BatchedWorksTests(unittest.TestCase):
    def test_full_authors_skip_fallback(self):
        works = [work(f"W{i}", f"Paper {i}", f"2026-0{i}-01", ["A1", "A2"]) for i in range(1, 7)]
        client = FakeOpenAlex([], works)
        cache = initial_ingestion.Cache("", enabled=False)
        result = initial_ingestion.fetch_recent_works_batched(client, cache, ["A1", "A2"])
        self.assertEqual([p["id"] for p in result["A1"]], ["W6", "W5", "W4", "W3", "W2"])
        self.assertTrue(all("A1|A2" in p["filter"] for _, p in client.calls), "no per-author fallback queries")
        self.assertEqual(len(client.calls), 3, "stops paging once every author has enough works")


class PipelineTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.config = os.path.join(self.tmp, "config.json")
        with open(self.config, "w") as fh:
            json.dump({"source": "test", "universities": [{
                "rank": 1, "name": "Massachusetts Institute of Technology", "country_code": "US",
                "openalex_search": ["Massachusetts Institute of Technology"], "openalex_id": None,
                "directories": [{"url": "https://dmse.mit.edu/people"}],
            }]}, fh)
        initial_ingestion.CACHE_DIR = os.path.join(self.tmp, "cache")
        self.authors = [author("A1", "Jane Doe", orcid="https://orcid.org/0000-0001"),
                        author("A2", "Rahul Kumar", cites=9000),
                        author("A3", "Wei Zhang", orcid="https://orcid.org/0000-0003", cites=100)]
        self.works = [work("W1", "Autonomous Discovery of Battery Electrolytes", "2026-03-02", ["A1", "A2"]),
                      work("W2", "Graph Networks for Crystals", "2025-11-20", ["A2"])]
        self.web = FakeWeb({
            "https://dmse.mit.edu/people": """<div class='grid'>
              <div class='person'><h3>Rahul Kumar</h3><p>Professor of Materials Science and Engineering</p>
                <a href='/people/rahul-kumar'>Profile</a> <span>rkumar (at) mit.edu</span></div>
              <div class='person'><h3>Someone Else</h3><a href='mailto:other@mit.edu'>other@mit.edu</a></div></div>""",
            "https://pub.orcid.org/v3.0/0000-0001/person": json.dumps({
                "emails": {"email": []},
                "researcher-urls": {"researcher-url": [{"url": {"value": "https://www.mit.edu/~jdoe/"}}]}}),
            "https://www.mit.edu/~jdoe/": "<html><body><h1>Jane Doe</h1><p>Associate Professor of Chemistry</p>"
                                          "<p>Email: jane.doe [at] mit [dot] edu</p></body></html>",
            "https://pub.orcid.org/v3.0/0000-0003/person": json.dumps({"emails": {"email": []}}),
        })

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def ingest(self):
        client = FakeOpenAlex(self.authors, self.works)
        records = initial_ingestion.main(["--config", self.config, "--out-dir", self.tmp, "--per-institution", "10"],
                                         client=client, web=self.web)
        return records, client

    def test_ingestion_schema_and_contacts(self):
        records, client = self.ingest()
        by_name = {r["name"]: r for r in records}
        jane, rahul, wei = by_name["Jane Doe"], by_name["Rahul Kumar"], by_name["Wei Zhang"]

        self.assertEqual(jane["email"], "jane.doe@mit.edu")
        self.assertEqual(jane["profile_url"], "https://www.mit.edu/~jdoe/")
        self.assertEqual(jane["title"], "Associate Professor of Chemistry")
        self.assertEqual(rahul["email"], "rkumar@mit.edu")
        self.assertEqual(rahul["profile_url"], "https://dmse.mit.edu/people/rahul-kumar")
        self.assertEqual(rahul["title"], "Professor of Materials Science and Engineering")
        self.assertIn("missing_email", wei["flags"])
        self.assertEqual(wei["profile_url"], "https://orcid.org/0000-0003")
        self.assertEqual(records[-1]["name"], "Wei Zhang", "unverified records sort last")

        for key in ("id", "name", "title", "email", "profile_url", "institution", "primary_domain",
                    "domain_weights", "citation_count", "recent_publications"):
            self.assertIn(key, jane)
        self.assertEqual(jane["id"], "A1")
        self.assertEqual(jane["institution"], {"id": "I63966007", "name": "Massachusetts Institute of Technology",
                                               "country_code": "US", "rank": 1})
        self.assertEqual(jane["recent_publications"][0]["title"], "Autonomous Discovery of Battery Electrolytes")
        batched = [p["filter"] for path, p in client.calls if path == "works" and "|" in p.get("filter", "")]
        self.assertTrue(batched and batched[0].startswith("author.id:A1|A2|A3"), "recent works fetched in one OR query")

        unis = json.loads(pathlib.Path(self.tmp, "universities.json").read_text())
        self.assertEqual(unis[0]["id"], "I63966007", "skips the hospital that also matched the search")
        self.assertIn("Materials Chemistry", json.loads(pathlib.Path(self.tmp, "domains.json").read_text()))
        # faculty_index.json is valid JSON with one record per line
        lines = pathlib.Path(self.tmp, "faculty_index.json").read_text().splitlines()
        self.assertEqual(len(lines), len(records) + 2)

    def test_embeddings_and_cdc(self):
        self.ingest()
        build_search_index.main(["--data-dir", self.tmp], encoder=FakeEncoder())
        meta = json.loads(pathlib.Path(self.tmp, "faculty_embeddings.json").read_text())
        raw = np.frombuffer(base64.b64decode(meta["data"]), dtype=np.int8)
        self.assertEqual((meta["model"], meta["dim"], meta["dtype"]), ("Xenova/all-MiniLM-L6-v2", 384, "int8"))
        self.assertEqual(raw.size, meta["count"] * meta["dim"])
        vecs = raw.reshape(meta["count"], meta["dim"]).astype(np.float32) / meta["scale"]
        np.testing.assert_allclose(np.linalg.norm(vecs, axis=1), 1.0, atol=0.02)

        # A month later: one new paper for Jane, refreshed citation count for Rahul.
        self.works.append(work("W3", "Self-Driving Labs for Solid Electrolytes", build_search_index.now_iso()[:10], ["A1", "A9"]))
        refreshed = dict(self.authors[1], cited_by_count=9500)
        client = FakeOpenAlex(self.authors, self.works, refreshed={"A2": refreshed})
        stats = cdc_update.main(["--data-dir", self.tmp], client=client)
        index = {r["id"]: r for r in json.loads(pathlib.Path(self.tmp, "faculty_index.json").read_text())}
        self.assertEqual(index["A1"]["recent_publications"][0]["title"], "Self-Driving Labs for Solid Electrolytes")
        self.assertEqual(len([p for p in index["A1"]["recent_publications"] if p["id"] == "W1"]), 1)
        self.assertEqual(index["A2"]["citation_count"], 9500)
        self.assertEqual(stats["publications_added"], 1)
        flt = next(p["filter"] for path, p in client.calls if "authorships.institutions.id" in p.get("filter", ""))
        self.assertIn("authorships.institutions.id:I63966007", flt)

    def test_cdc_refuses_sample_data(self):
        with self.assertRaises(SystemExit):
            cdc_update.main(["--data-dir", self.tmp], client=FakeOpenAlex([], []))

    def read(self, name):
        return json.loads(pathlib.Path(self.tmp, name).read_text())

    def test_shards(self):
        records, _ = self.ingest()
        build_search_index.main(["--data-dir", self.tmp], encoder=FakeEncoder())
        uni = self.read("universities.json")[0]
        self.assertEqual((uni["faculty_file"], uni["embeddings_file"], uni["faculty_count"]),
                         ("faculty/I63966007.json", "embeddings/I63966007.json", 3))
        shard = self.read(uni["faculty_file"])
        self.assertEqual([r["id"] for r in shard], [r["id"] for r in records])
        self.assertEqual(self.read(uni["embeddings_file"])["ids"], [r["id"] for r in shard])
        row = self.read("faculty_search.json")[0]
        self.assertEqual(set(row), {"id", "name", "title", "institution_id", "primary_domain", "domains",
                                    "citation_count", "email", "profile_url", "has_email", "seniority_score",
                                "first_author_recent", "last_author_recent", "recent_works", "last_publication_year", "record_file"})
        # Shard embeddings equal the matching rows of the combined file.
        combined = self.read("faculty_embeddings.json")
        self.assertEqual(self.read(uni["embeddings_file"])["data"], combined["data"])

        # Above the combined limit the single-file index and embeddings go away; shards stay.
        unis = self.read("universities.json")
        faculty.write_records(shard, unis, self.tmp, combined_limit=2)
        build_search_index.main(["--data-dir", self.tmp], encoder=FakeEncoder())
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "faculty_index.json")))
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "faculty_embeddings.json")))
        self.assertEqual(len(self.read(uni["embeddings_file"])["ids"]), 3)
        # CDC reads and rewrites the shards.
        stats = cdc_update.main(["--data-dir", self.tmp], client=FakeOpenAlex(self.authors, self.works))
        self.assertEqual(stats["faculty_refreshed"], 3)
        self.assertEqual(len(self.read(uni["faculty_file"])), 3)


if __name__ == "__main__":
    unittest.main()
