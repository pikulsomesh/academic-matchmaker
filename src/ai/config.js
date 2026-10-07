// Models and file locations shared by the local AI worker, the hook and the
// data pipeline. Keep EMBEDDING_MODEL and the text recipe in vectors.js in
// sync with scripts/build_search_index.py so query and faculty vectors live in
// the same space.

// Quantized ONNX export of Qwen2.5-0.5B-Instruct (q4f16 / q4 / q8 variants).
export const CHAT_MODEL = 'onnx-community/Qwen2.5-0.5B-Instruct'

// Sentence-transformers MiniLM, 384-dim, mean pooled and L2 normalized.
export const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2'
export const EMBEDDING_DIM = 384

// Precomputed faculty vectors written by scripts/build_search_index.py.
// When the file is missing, the hook embeds faculty in the browser instead.
export const FACULTY_EMBEDDINGS_PATH = 'data/faculty_embeddings.json'

// How much extracted document text the 0.5B model sees in one prompt.
export const MAX_DOCUMENT_CHARS = 6000
