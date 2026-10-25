"""Concept tags (scripts/tags.py). Run: python -m unittest discover scripts/tests"""

import json
import os
import pathlib
import shutil
import sys
import tempfile
import unittest
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import faculty  # noqa: E402
import tags  # noqa: E402

TOPICS = [
    {"display_name": "Antimicrobial Peptides and Activities", "count": 12},
    {"display_name": "Inflammatory Bowel Disease", "count": 30},
    {"display_name": "Gut microbiota and health", "count": 12},
]


def paper(wid, keywords):
    return {"id": f"https://openalex.org/{wid}", "title": f"Paper {wid}", "publication_year": 2026,
            "publication_date": "2026-01-01", "authorships": [],
            "keywords": [{"display_name": k, "score": s} for k, s in keywords]}


class TagTests(unittest.TestCase):
    def test_topics_strongest_first(self):
        self.assertEqual(tags.topic_tags(TOPICS), ["Inflammatory Bowel Disease", "Antimicrobial Peptides and Activities",
                                                   "Gut microbiota and health"])
        many = [{"display_name": f"T{i}", "count": i} for i in range(10)]
        self.assertEqual(len(tags.topic_tags(many)), tags.MAX_TOPIC_TAGS)

    def test_keywords_summed_across_papers_and_low_scores_dropped(self):
        pubs = [faculty.publication_entry(paper("W1", [("Peptide", 0.6), ("Strategy", 0.1)])),
                faculty.publication_entry(paper("W2", [("Peptide", 0.5), ("Colitis", 0.7)])),
                faculty.publication_entry(paper("W3", [("Inflammatory Bowel Disease", 0.9)]))]
        self.assertEqual(tags.keyword_tags(pubs, exclude=["inflammatory bowel disease"]), ["Peptide", "Colitis"])

    def test_record_tags_and_stored_keywords_survive_cached_papers(self):
        record = {"recent_publications": [faculty.publication_entry(paper("W1", [("Peptide", 0.8)]))]}
        tags.apply_tags(record, TOPICS)
        self.assertEqual(tags.record_tags(record)[-1], "Peptide")
        # Papers cached before keywords were fetched carry no _kw: the stored keywords stay.
        record["recent_publications"] = faculty.strip_transient(record["recent_publications"])
        tags.apply_tags(record)
        self.assertEqual(record["keywords"], ["Peptide"])
        self.assertNotIn("_kw", record["recent_publications"][0])

    def test_vocabulary_and_synonym_files(self):
        d = tempfile.mkdtemp()
        try:
            records = [{"topics": ["Inflammatory Bowel Disease"], "keywords": ["Peptide"]},
                       {"topics": ["Inflammatory Bowel Disease"]}]
            info = {"Inflammatory Bowel Disease": {"subfield": "Gastroenterology", "keywords": ["Crohn's disease"]}}
            index = tags.write_vocabulary(d, records, info)
            vocab = json.loads(pathlib.Path(d, tags.TAGS_FILE).read_text())
            self.assertEqual(vocab, {"format": "tags-v1", "tags": ["Inflammatory Bowel Disease", "Peptide"],
                                     "counts": [2, 1], "kinds": "tk"})
            self.assertEqual(index, {"Inflammatory Bowel Disease": 0, "Peptide": 1})
            syn = json.loads(pathlib.Path(d, tags.SYNONYMS_FILE).read_text())
            self.assertEqual(syn["subfields"], ["Gastroenterology"])
            self.assertEqual(syn["topics"], {"0": [0, ["Crohn's disease"]]})
        finally:
            shutil.rmtree(d)

    def test_search_rows_point_at_the_shared_vocabulary(self):
        row = dict(id="A1", name="Ada", institution_id="I1", domains=[], tags=["Peptide", "Colitis"])
        data = faculty.compact_search_file([row], {"Colitis": 0, "Peptide": 1}, "tags.json")
        self.assertEqual(data["tags_file"], "tags.json")
        self.assertNotIn("tags", data)
        self.assertEqual(data["rows"][0][-1], [1, 0])
        decoded = faculty.decode_search_file(json.loads(json.dumps(data)), ["Colitis", "Peptide"])[0]
        self.assertEqual(decoded["tags"], ["Peptide", "Colitis"])


class TopicInfoTests(unittest.TestCase):
    class Client:
        def __init__(self, fail=False):
            self.fail, self.calls = fail, 0

        def iterate(self, path, params):
            self.calls += 1
            if self.fail:
                raise RuntimeError("offline")
            yield {"display_name": "Inflammatory Bowel Disease", "subfield": {"display_name": "Gastroenterology"},
                   "keywords": ["Crohn's disease", "Ulcerative colitis"]}

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, "topics.json")

    def tearDown(self):
        shutil.rmtree(self.dir)

    def test_fetched_once_then_cached(self):
        client = self.Client()
        info = tags.refresh_topic_info(client, self.path, today=date(2026, 10, 25))
        self.assertEqual(info["Inflammatory Bowel Disease"]["subfield"], "Gastroenterology")
        tags.refresh_topic_info(client, self.path, today=date(2026, 11, 25))
        self.assertEqual(client.calls, 1)
        tags.refresh_topic_info(client, self.path, today=date(2027, 3, 1))
        self.assertEqual(client.calls, 2, "refreshed once older than the max age")

    def test_a_failed_fetch_never_stops_the_build(self):
        self.assertEqual(tags.refresh_topic_info(self.Client(fail=True), self.path), {})


if __name__ == "__main__":
    unittest.main()
