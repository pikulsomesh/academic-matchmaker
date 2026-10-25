"""Concept tags: what each researcher works on, as OpenAlex's own labels.

Every record carries `topics` (its strongest OpenAlex topics, e.g. "Inflammatory Bowel Disease Research") and
`keywords` (keywords OpenAlex assigned to its recent papers, e.g. "Peptide"). The site matches a visitor's
concepts ("gastrointestinal + peptide") against these instead of loose words, so generic words in a profile
("strategy") can't pull in unrelated people.

Published files:
  tags.json           {"format": "tags-v1", "tags": [names], "counts": [researchers per tag], "kinds": "tk…"}
                      Most used tags first, so the common ones get short ids. Search rows hold `tags` as ids into
                      this list (see faculty.compact_search_file).
  tag_synonyms.json   {"format": "tag-synonyms-v1", "subfields": [names],
                       "topics": {tag id: [subfield index, [OpenAlex keywords for that topic]]}}
                      Read by the site only when someone types a concept.

Topic keywords and subfields come from OpenAlex's topic list (about 4,500 topics, 23 requests), cached in
config/openalex_topics.json and refreshed every TOPIC_INFO_MAX_AGE_DAYS.
"""

import os
import sys
from collections import Counter, defaultdict
from datetime import date, datetime

MAX_TOPIC_TAGS = 6
MAX_KEYWORD_TAGS = 3
MAX_TAGS = 8
MIN_KEYWORD_SCORE = 0.3
TAGS_FILE = "tags.json"
SYNONYMS_FILE = "tag_synonyms.json"
TOPIC_INFO_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config", "openalex_topics.json")
TOPIC_INFO_MAX_AGE_DAYS = 90


def _clean(name):
    return " ".join(str(name or "").split())[:80]


def topic_tags(topics):
    """OpenAlex author topics -> the names of the strongest MAX_TOPIC_TAGS, most works first."""
    ranked = sorted((t for t in topics or [] if t.get("display_name")),
                    key=lambda t: (-float(t.get("count") or 0), t["display_name"]))
    return list(dict.fromkeys(_clean(t["display_name"]) for t in ranked))[:MAX_TOPIC_TAGS]


def work_keywords(work):
    """A work's OpenAlex keywords worth keeping -> [[name, score]], best first (the `_kw` working key)."""
    out = []
    for kw in work.get("keywords") or []:
        if not isinstance(kw, dict):
            continue
        name, score = _clean(kw.get("display_name")), float(kw.get("score") or 0)
        if name and score >= MIN_KEYWORD_SCORE:
            out.append([name, round(score, 2)])
    return sorted(out, key=lambda kv: -kv[1])[:5]


def keyword_tags(pubs, exclude=()):
    """Keywords across the recent papers (`_kw`), summed by score; ones a topic already names are left out."""
    totals, names = defaultdict(float), {}
    skip = {e.lower() for e in exclude}
    for pub in pubs or []:
        for name, score in pub.get("_kw") or []:
            key = name.lower()
            if key in skip:
                continue
            totals[key] += score
            names.setdefault(key, name)
    ranked = sorted(totals.items(), key=lambda kv: (-kv[1], kv[0]))
    return [names[key] for key, _ in ranked[:MAX_KEYWORD_TAGS]]


def apply_tags(record, topics=None, pubs=None):
    """Set record["topics"] / record["keywords"]. topics=None keeps the stored topics (no fresh author data);
    papers without keywords (cached before keywords were fetched) keep the stored keywords."""
    if topics is not None:
        fresh = topic_tags(topics)
        if fresh:
            record["topics"] = fresh
    keywords = keyword_tags(pubs if pubs is not None else record.get("recent_publications"),
                            exclude=record.get("topics") or ())
    if keywords:
        record["keywords"] = keywords
    return record


def record_tags(record):
    """All of a record's tags, strongest first: its topics, then its paper keywords, at most MAX_TAGS."""
    seen, out = set(), []
    for name in list(record.get("topics") or []) + list(record.get("keywords") or []):
        if name and name.lower() not in seen:
            seen.add(name.lower())
            out.append(name)
    return out[:MAX_TAGS]


# --- vocabulary ------------------------------------------------------------------------------

def build_vocabulary(records):
    """-> (names, counts, kinds, index): every tag in use, most researchers first; index maps name -> id."""
    counts, kinds = Counter(), {}
    for record in records:
        for name in record.get("keywords") or []:
            kinds.setdefault(name, "k")
        for name in record.get("topics") or []:
            kinds[name] = "t"
        counts.update(record_tags(record))
    names = sorted(counts, key=lambda n: (-counts[n], n))
    return names, [counts[n] for n in names], "".join(kinds.get(n, "k") for n in names), {n: i for i, n in enumerate(names)}


def write_vocabulary(data_dir, records, topic_info=None):
    """Write tags.json and tag_synonyms.json. -> name -> id index for the search files."""
    from faculty import write_json

    names, counts, kinds, index = build_vocabulary(records)
    write_json(os.path.join(data_dir, TAGS_FILE), {"format": "tags-v1", "tags": names, "counts": counts, "kinds": kinds},
               compact=True)
    topic_info = topic_info if topic_info is not None else load_topic_info()
    subfields, sub_index, topics = [], {}, {}
    for i, name in enumerate(names):
        info = topic_info.get(name) if kinds[i] == "t" else None
        if not info:
            continue
        sub = info.get("subfield")
        if sub and sub not in sub_index:
            sub_index[sub] = len(subfields)
            subfields.append(sub)
        topics[str(i)] = [sub_index.get(sub, -1), info.get("keywords") or []]
    write_json(os.path.join(data_dir, SYNONYMS_FILE),
               {"format": "tag-synonyms-v1", "subfields": subfields, "topics": topics}, compact=True)
    return index


# --- OpenAlex topic list ---------------------------------------------------------------------

def load_topic_info(path=TOPIC_INFO_PATH):
    """{topic name: {"subfield", "keywords"}} from the cached topic list, {} when there is none."""
    from faculty import read_json

    return (read_json(path, {}) or {}).get("topics") or {}


def fetch_topic_info(client):
    """Every OpenAlex topic's subfield and keywords (about 23 requests)."""
    info = {}
    for topic in client.iterate("topics", {"select": "id,display_name,keywords,subfield"}):
        name = _clean(topic.get("display_name"))
        if name:
            info[name] = {"subfield": (topic.get("subfield") or {}).get("display_name"),
                          "keywords": [_clean(k) for k in topic.get("keywords") or [] if _clean(k)][:12]}
    return info


def refresh_topic_info(client, path=TOPIC_INFO_PATH, max_age_days=TOPIC_INFO_MAX_AGE_DAYS, today=None):
    """Re-fetch the topic list when it is missing or old. Never fails a build: on any error the cached copy
    (possibly empty) is used and the site falls back to its own synonym list."""
    from faculty import read_json, write_json

    cached = read_json(path, {}) or {}
    today = today or date.today()
    try:
        fetched_on = datetime.strptime(cached.get("fetched", ""), "%Y-%m-%d").date()
        fresh = (today - fetched_on).days < max_age_days and cached.get("topics")
    except ValueError:
        fresh = False
    if fresh or client is None:
        return cached.get("topics") or {}
    try:
        topics = fetch_topic_info(client)
    except Exception as err:  # noqa: BLE001 - synonyms are optional, a failed fetch must not stop a build
        print(f"Warning: could not fetch the OpenAlex topic list ({err}); using the cached copy.", file=sys.stderr)
        return cached.get("topics") or {}
    if topics:
        write_json(path, {"fetched": today.isoformat(), "topics": topics})
    return topics or cached.get("topics") or {}
