"""Offline tests for lab signals, the optional-field retry and the quality gate."""

import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import build_search_index  # noqa: E402
import faculty  # noqa: E402
import quality_gate  # noqa: E402
from openalex import OpenAlexClient  # noqa: E402
from test_pipeline import FakeEncoder, SizeAndIndexTests  # noqa: E402


def wk(wid, date, author, position_of, funders=()):
    """A work where `position_of` maps author id -> author_position."""
    return {"id": f"https://openalex.org/{wid}", "title": f"Paper {wid}", "publication_year": int(date[:4]),
            "publication_date": date,
            "authorships": [{"author": {"id": f"https://openalex.org/{a}"}, "author_position": p}
                            for a, p in position_of.items()],
            "funders": [{"display_name": f} for f in funders]}


class LabSignalTests(unittest.TestCase):
    def test_distinct_first_authors_and_funders(self):
        works = [wk("W1", "2026-01-01", "P", {"S1": "first", "P": "last"}, ["NIH", "NSF"]),
                 wk("W2", "2025-06-01", "P", {"S2": "first", "P": "last"}, ["NIH"]),
                 wk("W3", "2025-01-01", "P", {"S1": "first", "P": "last"}),
                 wk("W4", "2024-01-01", "P", {"P": "first", "X": "last"}, ["ERC"])]
        pubs = [faculty.publication_entry(w, "P") for w in works]
        signals = faculty.lab_signals(pubs)
        self.assertEqual((signals["lab_first_authors"], signals["lab_senior_papers"]), (2, 3))
        self.assertEqual(signals["recent_funders"], ["NIH", "ERC", "NSF"])

    def test_no_signal_without_last_author_papers(self):
        pubs = [faculty.publication_entry(wk("W1", "2026-01-01", "P", {"P": "first", "X": "last"}), "P")]
        self.assertEqual(faculty.lab_signals(pubs), {})

    def test_apply_keeps_larger_count_and_unions_funders(self):
        record = {"lab_first_authors": 4, "lab_senior_papers": 5, "recent_funders": ["NIH"]}
        new = [faculty.publication_entry(wk("W1", "2026-01-01", "P", {"S1": "first", "P": "last"}, ["NSF"]), "P")]
        faculty.apply_lab_signals(record, new)
        self.assertEqual((record["lab_first_authors"], record["lab_senior_papers"]), (4, 5))
        self.assertEqual(record["recent_funders"], ["NSF", "NIH"])

    def test_transient_keys_never_reach_the_files(self):
        pubs = [faculty.publication_entry(wk("W1", "2026-01-01", "P", {"S1": "first", "P": "last"}, ["NIH"]), "P")]
        self.assertIn("_fa", pubs[0])
        self.assertEqual(faculty.strip_transient(pubs)[0].keys(), {"id", "title", "year", "date", "position"})
        d = tempfile.mkdtemp()
        try:
            recs = SizeAndIndexTests().records(3)
            recs[0]["recent_publications"] = pubs
            faculty.write_records(recs, [{"id": "I1", "name": "U", "country_code": "US", "rank": 1}], d)
            self.assertNotIn("_fa", open(os.path.join(d, "faculty", "I1.json")).read())
        finally:
            shutil.rmtree(d)

    def test_output_counts(self):
        author = {"counts_by_year": [{"year": y, "works_count": n} for y, n in
                                     [(2026, 9), (2025, 5), (2024, 4), (2023, 3), (2022, 2), (2021, 2), (2020, 1)]]}
        self.assertEqual(faculty.output_counts(author, 2026), {"works_recent_3y": 12, "works_prior_3y": 5})
        self.assertEqual(faculty.output_counts({}, 2026), {})


class OptionalFieldTests(unittest.TestCase):
    class Resp:
        def __init__(self, code, body=None):
            self.status_code, self._body, self.headers = code, body or {}, {}

        def json(self):
            return self._body

        def raise_for_status(self):
            raise RuntimeError(f"HTTP {self.status_code}")

    class Session:
        def __init__(self, owner):
            self.headers, self.owner, self.selects = {}, owner, []

        def get(self, url, params=None, timeout=None):
            self.selects.append(params.get("select"))
            if "funders" in params["select"]:
                return OptionalFieldTests.Resp(400)
            return OptionalFieldTests.Resp(200, {"results": []})

    def test_retries_without_funders_and_remembers(self):
        session = self.Session(self)
        client = OpenAlexClient(mailto="", api_key="", per_second=1000, session=session)
        client.get("works", {"select": "id,title,funders"})
        client.get("works", {"select": "id,title,funders"})
        self.assertEqual(session.selects, ["id,title,funders", "id,title", "id,title"])

    def test_other_400s_still_raise(self):
        class Bad(self.Session):
            def get(self, url, params=None, timeout=None):
                return OptionalFieldTests.Resp(400)
        client = OpenAlexClient(mailto="", api_key="", per_second=1000, session=Bad(self))
        with self.assertRaises(RuntimeError):
            client.get("works", {"select": "id,title"})


class QualityGateTests(unittest.TestCase):
    def setUp(self):
        self.dir, self.prev = tempfile.mkdtemp(), tempfile.mkdtemp()
        self.unis = [{"id": "I1", "name": "U", "country_code": "US", "rank": 1}]
        self.build(120)

    def tearDown(self):
        shutil.rmtree(self.dir)
        shutil.rmtree(self.prev)

    def build(self, n):
        recs = SizeAndIndexTests().records(n)
        faculty.write_records(recs, self.unis, self.dir)
        build_search_index.main(["--data-dir", self.dir], encoder=FakeEncoder())
        meta = faculty.read_json(os.path.join(self.dir, "metadata.json"), {})
        meta.update(faculty_count=n, last_ingestion="2026-10-01", generated_at="2026-10-07T00:00:00Z")
        faculty.write_json(os.path.join(self.dir, "metadata.json"), meta)

    def check(self, **kw):
        return quality_gate.check_data(self.dir, self.prev, **kw)

    def test_good_build_passes_and_writes_status(self):
        report, summary = self.check(budget_mb=100)
        self.assertEqual(report.errors, [])
        status = quality_gate.write_status(self.dir, report, summary, "full", "http://run", self.prev)
        self.assertEqual((status["result"], status["people"]), ("ok", 120))
        self.assertTrue(os.path.exists(os.path.join(self.dir, "pipeline_status.json")))

    def test_shrinking_build_fails_unless_allowed(self):
        quality_gate.snapshot(self.dir, self.prev)
        self.build(60)
        report, _ = self.check()
        self.assertTrue(any(e.startswith("shrink") for e in report.errors), report.errors)
        report, _ = self.check(allow_shrink=True)
        self.assertEqual(report.errors, [])

    def test_missing_cluster_and_record_files_fail(self):
        os.remove(os.path.join(self.dir, "vectors", "0.json"))
        report, _ = self.check()
        self.assertTrue(any(e.startswith("vectors") for e in report.errors), report.errors)
        os.remove(os.path.join(self.dir, "faculty", "I1.json"))
        report, _ = self.check()
        self.assertTrue(any(e.startswith("record_files") for e in report.errors), report.errors)

    def test_over_budget_and_missing_files_fail(self):
        report, _ = self.check(budget_mb=0.001)
        self.assertTrue(any(e.startswith("size") for e in report.errors))
        os.remove(os.path.join(self.dir, "faculty_search.json"))
        report, _ = self.check()
        self.assertTrue(any(e.startswith("files") for e in report.errors))


if __name__ == "__main__":
    unittest.main()
