#!/usr/bin/env python3
"""Precompute sentence embeddings for every faculty record.

Uses the ONNX export and tokenizer of Xenova/all-MiniLM-L6-v2 that Transformers.js loads in
the browser, with the same post-processing as
`pipeline('feature-extraction', ..., {pooling: 'mean', normalize: true})`, so browser query
vectors and these faculty vectors share one space.

Output: public/data/embeddings/<institution id>.json per university (rows match
public/data/faculty/<institution id>.json), plus public/data/faculty_embeddings.json while the
single-file faculty_index.json exists. Each file follows the contract read by
src/ai/vectors.js (decodeEmbeddingIndex):
  {"model": "Xenova/all-MiniLM-L6-v2", "dim": 384, "dtype": "int8", "scale": 127,
   "ids": [...], "data": "<base64 of ids.length x 384 int8, row-major>", ...}
int8 value = round(x * 127) of the unit vector; row i belongs to ids[i].
"""

import argparse
import base64
import hashlib
import math
import os
import shutil
import sys
import urllib.request

import numpy as np

from faculty import DATA_DIR, load_records, now_iso, read_json, write_json

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL_ID = "Xenova/all-MiniLM-L6-v2"
MODEL_FILE = "onnx/model.onnx"  # full precision, same weights as sentence-transformers
HF_BASE = f"https://huggingface.co/{MODEL_ID}/resolve/main"
MODEL_DIR = os.path.join(ROOT, ".cache", "models", MODEL_ID.replace("/", "__"))
MAX_TOKENS = 256
DIM = 384
SCALE = 127
MAX_PUBLICATIONS = 10


def faculty_text(record):
    """Text embedded per faculty member. Must equal facultyEmbeddingText() in src/ai/vectors.js,
    which the browser uses when it has to embed faculty itself."""
    weights = record.get("domain_weights") or {}
    domains = [name for name, _ in sorted(weights.items(), key=lambda kv: -kv[1])]
    if record.get("primary_domain") and record["primary_domain"] not in domains:
        domains.insert(0, record["primary_domain"])
    titles = [p.get("title") for p in (record.get("recent_publications") or [])[:MAX_PUBLICATIONS]]
    titles = [t for t in titles if t]
    parts = []
    if record.get("title"):
        parts.append(f"{record['title']}.")
    if domains:
        parts.append(f"Research areas: {', '.join(domains)}.")
    if titles:
        parts.append(f"Recent work: {'; '.join(titles)}.")
    return " ".join(parts)


def download(name):
    path = os.path.join(MODEL_DIR, name)
    if not os.path.exists(path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        print(f"Downloading {MODEL_ID}/{name}", file=sys.stderr)
        urllib.request.urlretrieve(f"{HF_BASE}/{name}", path + ".part")
        os.replace(path + ".part", path)
    return path


class MiniLMEncoder:
    def __init__(self):
        import onnxruntime as ort
        from tokenizers import Tokenizer

        self.tokenizer = Tokenizer.from_file(download("tokenizer.json"))
        self.tokenizer.enable_truncation(max_length=MAX_TOKENS)
        self.tokenizer.enable_padding(pad_id=0, pad_token="[PAD]")
        self.session = ort.InferenceSession(download(MODEL_FILE), providers=["CPUExecutionProvider"])
        self.input_names = {i.name for i in self.session.get_inputs()}

    def __call__(self, texts):
        enc = self.tokenizer.encode_batch(texts)
        ids = np.array([e.ids for e in enc], dtype=np.int64)
        mask = np.array([e.attention_mask for e in enc], dtype=np.int64)
        feeds = {"input_ids": ids, "attention_mask": mask}
        if "token_type_ids" in self.input_names:
            feeds["token_type_ids"] = np.zeros_like(ids)
        hidden = self.session.run(None, feeds)[0]  # (batch, seq, dim)
        return mean_pool_normalize(hidden, mask)


def mean_pool_normalize(hidden, mask):
    m = mask[..., None].astype(np.float32)
    pooled = (hidden * m).sum(axis=1) / np.clip(m.sum(axis=1), 1e-9, None)
    return pooled / np.clip(np.linalg.norm(pooled, axis=1, keepdims=True), 1e-12, None)


def quantize(vectors):
    return np.clip(np.rint(vectors * SCALE), -127, 127).astype(np.int8)


def build(records, encoder, batch_size=64):
    texts = [faculty_text(r) for r in records]
    out = np.zeros((len(texts), DIM), dtype=np.float32)
    for start in range(0, len(texts), batch_size):
        out[start:start + batch_size] = encoder(texts[start:start + batch_size])
        if start and start % (batch_size * 50) == 0:
            print(f"  embedded {start}/{len(texts)}", file=sys.stderr)
    return texts, out


def payload(ids, texts, q):
    """One embeddings file in the faculty_embeddings.json contract (see module docstring)."""
    return {
        "model": MODEL_ID,
        "model_file": MODEL_FILE,
        "pooling": "mean",
        "normalize": True,
        "dim": DIM,
        "dtype": "int8",
        "scale": SCALE,
        "count": len(ids),
        "generated_at": now_iso(),
        "content_hash": hashlib.sha1("\n".join(texts).encode()).hexdigest(),
        "ids": list(ids),
        "data": base64.b64encode(np.ascontiguousarray(q).tobytes(order="C")).decode("ascii"),
    }


VECTORS_DIR = "vectors"
KMEANS_SAMPLE = 50000
KMEANS_ITERATIONS = 8


def kmeans(unit, k, seed=0):
    """Plain k-means on unit vectors (float32 rows) -> k x dim unit centroids. Trained on a sample."""
    rng = np.random.default_rng(seed)
    sample = unit[rng.choice(len(unit), size=min(len(unit), KMEANS_SAMPLE), replace=False)]
    centroids = sample[rng.choice(len(sample), size=k, replace=False)].copy()
    for _ in range(KMEANS_ITERATIONS):
        nearest = np.argmax(sample @ centroids.T, axis=1)
        for c in range(k):
            members = sample[nearest == c]
            if len(members):
                mean = members.mean(axis=0)
                centroids[c] = mean / (np.linalg.norm(mean) or 1.0)
    return centroids


def build_ivf(ids, q, out_dir, k=None, institution_ids=None):
    """IVF index for the browser: centroids.json plus one file of member ids and vectors per cluster.

    The browser embeds the query, ranks the centroids, loads the nearest clusters and ranks those exactly.
    -> {"k", "dim", "model", "count"}
    """
    root = os.path.join(out_dir, VECTORS_DIR)
    shutil.rmtree(root, ignore_errors=True)
    n = len(ids)
    k = k or max(1, min(n, round(math.sqrt(n))))
    unit = q.astype(np.float32) / SCALE
    unit /= np.maximum(np.linalg.norm(unit, axis=1, keepdims=True), 1e-9)
    centroids = kmeans(unit, k)
    assignment = np.empty(n, dtype=np.int32)
    for start in range(0, n, 20000):
        assignment[start:start + 20000] = np.argmax(unit[start:start + 20000] @ centroids.T, axis=1)
    write_json(os.path.join(root, "centroids.json"), {
        "k": k, "dim": DIM, "dtype": "int8", "scale": SCALE, "model": MODEL_ID,
        "data": base64.b64encode(quantize(centroids).tobytes()).decode("ascii")}, compact=True)
    for c in range(k):
        rows = np.flatnonzero(assignment == c)
        write_json(os.path.join(root, f"{c}.json"), {
            "ids": [ids[i] for i in rows],
            "institution_ids": [institution_ids[i] for i in rows] if institution_ids else [],
            "dim": DIM, "dtype": "int8", "scale": SCALE,
            "data": base64.b64encode(q[rows].tobytes()).decode("ascii")}, compact=True)
    return {"k": k, "dim": DIM, "model": MODEL_ID, "count": n}


def site_reads_vectors():
    """True once the website loads vectors/centroids.json, so the per-university embeddings can go."""
    for folder, _, files in os.walk(os.path.join(ROOT, "src")):
        for name in files:
            if name.endswith((".js", ".jsx", ".ts", ".tsx")):
                with open(os.path.join(folder, name), encoding="utf-8") as fh:
                    if "vectors/centroids.json" in fh.read():
                        return True
    return False


def main(argv=None, encoder=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--data-dir", default=DATA_DIR)
    p.add_argument("--batch-size", type=int, default=64)
    p.add_argument("--ivf-only", action="store_true", help="skip the per-university embeddings files")
    args = p.parse_args(argv)

    records, universities = load_records(args.data_dir)
    encoder = encoder or MiniLMEncoder()
    texts, vectors = build(records, encoder, args.batch_size)
    q = quantize(vectors)
    ids = [r["id"] for r in records]

    # One embeddings shard per university, in that university's faculty-file order. Kept until the
    # website reads vectors/ (IVF), then dropped: one copy of the vectors keeps the data small.
    embeddings_dir = os.path.join(args.data_dir, "embeddings")
    use_ivf_only = args.ivf_only or site_reads_vectors()
    if use_ivf_only:
        shutil.rmtree(embeddings_dir, ignore_errors=True)
    row_of = {fid: i for i, fid in enumerate(ids)}
    for uni in universities:
        if use_ivf_only:
            uni.pop("embeddings_file", None)
            continue
        if not uni.get("embeddings_file"):
            continue
        shard_ids = [r["id"] for r in records if r["institution"].get("id") == uni["id"]]
        rows = [row_of[fid] for fid in shard_ids]
        write_json(os.path.join(args.data_dir, uni["embeddings_file"]),
                   payload(shard_ids, [texts[i] for i in rows], q[rows]), compact=True)
    write_json(os.path.join(args.data_dir, "universities.json"), universities)
    vectors = build_ivf(ids, q, args.data_dir, institution_ids=[r["institution"].get("id") for r in records])

    # The single-file version exists exactly when faculty_index.json does.
    combined = os.path.join(args.data_dir, "faculty_embeddings.json")
    if os.path.exists(os.path.join(args.data_dir, "faculty_index.json")):
        write_json(combined, payload(ids, texts, q), compact=True)
    elif os.path.exists(combined):
        os.remove(combined)

    meta_path = os.path.join(args.data_dir, "metadata.json")
    meta = read_json(meta_path, {})
    meta["embeddings"] = {"model": MODEL_ID, "dim": DIM, "dtype": "int8", "count": len(records)}
    meta["vectors"] = vectors
    write_json(meta_path, meta)
    print(f"Embedded {len(records)} faculty ({q.nbytes / 1e6:.1f} MB of vectors)", file=sys.stderr)


if __name__ == "__main__":
    main()
