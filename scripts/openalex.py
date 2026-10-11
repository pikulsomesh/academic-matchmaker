"""Small OpenAlex API client shared by the ingestion and CDC scripts.

Reads two optional environment variables:
  OPENALEX_MAILTO   contact email, puts requests in OpenAlex's polite pool
  OPENALEX_API_KEY  API key, for accounts with higher limits
"""

import os
import sys
import threading
import time

import requests

BASE_URL = "https://api.openalex.org"
USER_AGENT = "academic-matchmaker-pipeline/1.0 (+https://github.com/pikulsomesh/academic-matchmaker)"
MAX_OR_VALUES = 100  # OpenAlex caps OR filters (a|b|c) at 100 values
MAX_RETRY_WAIT = 300  # seconds; a longer Retry-After means the daily budget is gone, so stop instead of sleeping
OPTIONAL_SELECT_FIELDS = ("funders",)  # nice-to-have fields: if OpenAlex rejects them, retry without


def short_id(openalex_id):
    """'https://openalex.org/A123' -> 'A123'."""
    if not openalex_id:
        return None
    return openalex_id.rstrip("/").rsplit("/", 1)[-1]


class RateLimited(Exception):
    """OpenAlex asked us to wait longer than is worth sleeping for (its daily budget is used up)."""

    def __init__(self, retry_after, status):
        super().__init__(f"OpenAlex answered {status} and asked to wait {retry_after:.0f}s")
        self.retry_after = retry_after
        self.status = status


def chunks(items, size):
    for i in range(0, len(items), size):
        yield items[i:i + size]


class RateLimiter:
    def __init__(self, per_second):
        self.interval = 1.0 / per_second
        self.lock = threading.Lock()
        self.next_at = 0.0

    def wait(self):
        with self.lock:
            now = time.monotonic()
            delay = self.next_at - now
            self.next_at = max(now, self.next_at) + self.interval
        if delay > 0:
            time.sleep(delay)


class OpenAlexClient:
    def __init__(self, mailto=None, api_key=None, per_second=8, session=None):
        self.mailto = mailto if mailto is not None else os.environ.get("OPENALEX_MAILTO")
        self.api_key = api_key if api_key is not None else os.environ.get("OPENALEX_API_KEY")
        self.limiter = RateLimiter(per_second)
        self.session = session or requests.Session()
        self.session.headers["User-Agent"] = USER_AGENT
        self.request_count = 0
        self.status_counts = {}
        self.dropped_fields = set()

    def get(self, path, params=None, retries=5):
        params = dict(params or {})
        self._drop_unsupported(params)
        if self.mailto:
            params["mailto"] = self.mailto
        if self.api_key:
            params["api_key"] = self.api_key
        url = path if path.startswith("http") else f"{BASE_URL}/{path.lstrip('/')}"
        for attempt in range(retries):
            self.limiter.wait()
            self.request_count += 1
            try:
                resp = self.session.get(url, params=params, timeout=60)
            except requests.RequestException:
                if attempt == retries - 1:
                    raise
                time.sleep(2 ** attempt)
                continue
            self.status_counts[resp.status_code] = self.status_counts.get(resp.status_code, 0) + 1
            if resp.status_code == 200:
                return resp.json()
            if resp.status_code in (429, 500, 502, 503, 504) and attempt < retries - 1:
                retry_after = resp.headers.get("Retry-After")
                wait = float(retry_after) if retry_after and retry_after.isdigit() else 2 ** (attempt + 1)
                if wait > MAX_RETRY_WAIT:
                    raise RateLimited(wait, resp.status_code)
                time.sleep(wait)
                continue
            if resp.status_code == 400 and self._drop_optional(params):
                continue
            resp.raise_for_status()
        raise RuntimeError(f"OpenAlex request failed: {url}")

    def _drop_unsupported(self, params):
        if self.dropped_fields and params.get("select"):
            params["select"] = ",".join(f for f in params["select"].split(",") if f not in self.dropped_fields)

    def _drop_optional(self, params):
        """On a 400, drop the optional select fields (once) so a field OpenAlex renamed can't break a build."""
        fields = (params.get("select") or "").split(",")
        gone = {f for f in OPTIONAL_SELECT_FIELDS if f in fields}
        if not gone:
            return False
        self.dropped_fields |= gone
        print(f"Warning: OpenAlex rejected a request; continuing without {sorted(gone)}", file=sys.stderr, flush=True)
        self._drop_unsupported(params)
        return True

    def iterate(self, path, params=None, max_results=None):
        """Yield every result of a list endpoint using cursor pagination."""
        params = dict(params or {})
        params.setdefault("per-page", 200)
        params["cursor"] = "*"
        seen = 0
        while params["cursor"]:
            data = self.get(path, params)
            for item in data.get("results", []):
                yield item
                seen += 1
                if max_results and seen >= max_results:
                    return
            params["cursor"] = (data.get("meta") or {}).get("next_cursor")
            if not data.get("results"):
                return
