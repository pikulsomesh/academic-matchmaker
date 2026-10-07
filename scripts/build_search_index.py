#!/usr/bin/env python3
"""Precompute sentence embeddings for every faculty record.

Uses the exact ONNX weights and tokenizer that Transformers.js loads in the browser
(Xenova/all-MiniLM-L6-v2, onnx/model_quantized.onnx, the library's default), with the
same post-processing as `pipeline('feature-extraction', ..., {pooling: 'mean', normalize: true})`.
A query embedded in the browser therefore lives in the same space, and cosine similarity
is a plain dot product.

Outputs (in public/data/):
  faculty_embeddings.bin   int8, row-major, count x dim; row i = faculty_embeddings.json ids[i]
  faculty_embeddings.json  {model, dim, count, dtype, scale, ids, ...}

Browser-side decode: value = int8 / scale (rows are unit length to within quantization error).
"""

import argparse
import hashlib
import os
import sys
import urllib.request

import numpy as np

from faculty import DATA_DIR, now_iso, read_json, write_json

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL_ID = "Xenova/all-MiniLM-L6-v2"
MODEL_FILE = "onnx/model_quantized.onnx"
HF_BASE = f"https://huggingface.co/{MODEL_ID}/resolve/main"
MODEL_DIR = os.path.join(ROOT, ".cache", "models", MODEL_ID.replace("/", "__"))
MAX_TOKENS = 256
DIM = 384
SCALE = 127
MAX_TITLES = 5


def faculty_text(record):
    """Text that represents a faculty member's research for embedding."""
    parts = []
    title = record.get("title") or ""
    if " of " in title or " in " in title:
        parts.append(title + ".")
    areas = list(record.get("domain_weights", {}).keys())
    if record.get("primary_domain") and record["primary_domain"] not in areas:
        areas.insert(0, record["primary_domain"])
    if areas:
        parts.append("Research areas: " + ", ".join(areas) + ".")
    titles = [p["title"].rstrip(".") for p in record.get("recent_publications", [])[:MAX_TITLES] if p.get("title")]
    if titles:
        parts.append("Recent work: " + "; ".join(titles) + ".")
    return " ".join(parts) or record.get("name", "")


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


def main(argv=None, encoder=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--data-dir", default=DATA_DIR)
    p.add_argument("--batch-size", type=int, default=64)
    args = p.parse_args(argv)

    records = read_json(os.path.join(args.data_dir, "faculty_index.json"), [])
    encoder = encoder or MiniLMEncoder()
    texts, vectors = build(records, encoder, args.batch_size)
    q = quantize(vectors)
    with open(os.path.join(args.data_dir, "faculty_embeddings.bin"), "wb") as fh:
        fh.write(q.tobytes(order="C"))
    write_json(os.path.join(args.data_dir, "faculty_embeddings.json"), {
        "model": MODEL_ID,
        "model_file": MODEL_FILE,
        "pooling": "mean",
        "normalize": True,
        "dim": DIM,
        "count": len(records),
        "dtype": "int8",
        "scale": SCALE,
        "file": "faculty_embeddings.bin",
        "generated_at": now_iso(),
        "content_hash": hashlib.sha1("\n".join(texts).encode()).hexdigest(),
        "ids": [r["id"] for r in records],
    }, compact=True)
    meta_path = os.path.join(args.data_dir, "metadata.json")
    meta = read_json(meta_path, {})
    meta["embeddings"] = {"model": MODEL_ID, "dim": DIM, "dtype": "int8", "count": len(records)}
    write_json(meta_path, meta)
    print(f"Embedded {len(records)} faculty -> faculty_embeddings.bin ({q.nbytes / 1e6:.1f} MB)", file=sys.stderr)


if __name__ == "__main__":
    main()
