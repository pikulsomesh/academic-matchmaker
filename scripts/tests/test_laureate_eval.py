"""Offline tests for the laureate test. Run: python -m unittest discover scripts/tests"""

import json
import os
import shutil
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import build_search_index  # noqa: E402
import laureate_eval  # noqa: E402
from test_pipeline import FakeEncoder  # noqa: E402


def person(aid, name, title, domains, papers):
    return {"id": aid, "name": name, "title": title, "primary_domain": domains[0],
            "domain_weights": {d: 1 / (i + 1) for i, d in enumerate(domains)},
            "institution": {"id": "I1", "name": "Wisconsin University"},
            "recent_publications": [{"title": t, "year": 2025} for t in papers]}


PEOPLE = [
    person("A1", "Francis Halzen", "Professor of Physics", ["Astrophysics", "Neutrino"],
           ["Observation of high energy astrophysical neutrinos", "IceCube neutrino detector at the South Pole"]),
    person("A2", "Ada Chem", "Professor of Chemistry", ["Organic Chemistry"], ["Asymmetric synthesis of chiral molecules"]),
    person("A3", "Bob Math", "Professor of Mathematics", ["Algebraic Geometry"], ["Rational points on curves"]),
]
MANIFEST = {"note": "test", "laureates": [
    {"id": "halzen-francis", "name": "Francis Halzen", "prize": "Nobel Prize in Physics", "year": 2026,
     "citation": "IceCube", "institution": "University of Wisconsin-Madison", "institution_match": "wisconsin"},
    {"id": "nobody", "name": "No Body", "prize": "Fields Medal", "year": 2026, "citation": "-",
     "institution": "Nowhere University", "institution_match": "nowhere"},
]}


class FakeClient:
    def get(self, path, params=None):
        return {"results": [
            {"id": "https://openalex.org/A1", "display_name": "Francis Halzen", "orcid": "https://orcid.org/0000-0000-0000-0001",
             "works_count": 900, "last_known_institutions": [{"display_name": "University of Wisconsin–Madison"}]},
            {"id": "https://openalex.org/A9", "display_name": "Francis Halzen", "orcid": None, "works_count": 3,
             "last_known_institutions": [{"display_name": "Elsewhere"}]},
        ]} if "Halzen" in params["search"] else {"results": []}


def fake_bridge(kind, arg):
    return {"ok": True, "name": "x", "interests": ["neutrino", "IceCube"],
            "embedding_text": "Research areas: neutrino, IceCube. high energy astrophysical neutrinos detector"}


class LaureateEvalTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        os.makedirs(os.path.join(self.dir, "faculty"))
        with open(os.path.join(self.dir, "faculty", "I1.json"), "w") as fh:
            json.dump(PEOPLE, fh)
        with open(os.path.join(self.dir, "universities.json"), "w") as fh:
            json.dump([{"id": "I1", "name": "Wisconsin University", "faculty_file": "faculty/I1.json",
                        "embeddings_file": "embeddings/I1.json"}], fh)
        with mock.patch.object(build_search_index, "vector_format", return_value="bits"):
            build_search_index.main(["--data-dir", self.dir], encoder=FakeEncoder())
        self.manifest = os.path.join(self.dir, "manifest.json")
        with open(self.manifest, "w") as fh:
            json.dump(MANIFEST, fh)

    def tearDown(self):
        shutil.rmtree(self.dir)

    def run_eval(self, **kw):
        with mock.patch.object(laureate_eval, "bridge", fake_bridge), mock.patch.object(laureate_eval, "CV_DIR", self.dir), mock.patch.object(laureate_eval, "MIN_TOP_SCORE", 0.05):
            return laureate_eval.main(["--data-dir", self.dir, "--manifest", self.manifest], client=FakeClient(), encoder=FakeEncoder(), **kw)

    def test_resolves_by_institution_and_ranks_the_person_first(self):
        self.assertEqual(self.run_eval(), 0)
        out = json.load(open(os.path.join(self.dir, "laureate_eval.json")))
        halzen, nobody = out["entries"]
        self.assertEqual(halzen["identity"]["openalex_id"], "A1")
        self.assertEqual(halzen["identity"]["orcid"], "0000-0000-0000-0001")
        run = halzen["runs"]["openalex"]
        self.assertEqual(run["status"], "passed")
        self.assertEqual(run["self_rank"], 1)
        self.assertEqual(run["matches"][0]["name"], "Francis Halzen")
        self.assertIn("neutrino", run["matches"][0]["connections"]["shared_interests"])
        self.assertTrue(run["matches"][0]["connections"]["papers"])
        self.assertEqual(halzen["runs"]["resume"]["status"], "skipped")

    def test_unresolved_person_is_reported_not_guessed(self):
        self.run_eval()
        out = json.load(open(os.path.join(self.dir, "laureate_eval.json")))
        nobody = out["entries"][1]
        self.assertIsNone(nobody["identity"]["openalex_id"])
        self.assertEqual(nobody["runs"]["openalex"]["status"], "skipped")
        self.assertEqual(out["summary"]["people_unresolved"], 1)
        self.assertEqual(out["status"], "passing")

    def test_no_vectors_means_not_run(self):
        shutil.rmtree(os.path.join(self.dir, "vectors"), ignore_errors=True)
        shutil.rmtree(os.path.join(self.dir, "embeddings"), ignore_errors=True)
        self.run_eval()
        self.assertEqual(json.load(open(os.path.join(self.dir, "laureate_eval.json")))["status"], "not_run")

    def test_crash_writes_error_status(self):
        class Boom:
            def get(self, *a, **k):
                raise RuntimeError("x")
        with mock.patch.object(laureate_eval, "load_vectors", side_effect=RuntimeError("disk")):
            code = laureate_eval.main(["--data-dir", self.dir, "--manifest", self.manifest], client=Boom(), encoder=FakeEncoder())
        self.assertEqual(code, 1)
        self.assertEqual(json.load(open(os.path.join(self.dir, "laureate_eval.json")))["status"], "error")

    def test_name_matching(self):
        self.assertTrue(laureate_eval.names_match("Henri B. Kagan", "H. B. Kagan"))
        self.assertTrue(laureate_eval.names_match("Georg Nagel", "Georg Nagel"))
        self.assertFalse(laureate_eval.names_match("Yu Deng", "Yu Wang"))


if __name__ == "__main__":
    unittest.main()
