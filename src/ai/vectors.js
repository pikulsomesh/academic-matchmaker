import { EMBEDDING_DIM, EMBEDDING_MODEL } from './config.js'

const MAX_PUBLICATIONS = 10

// The text each faculty record is embedded from. scripts/build_search_index.py
// must build exactly the same string (see the format note in project memory).
export function facultyEmbeddingText(faculty) {
  const domains = Object.entries(faculty.domain_weights ?? {})
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => name)
  if (faculty.primary_domain && !domains.includes(faculty.primary_domain)) {
    domains.unshift(faculty.primary_domain)
  }
  const publications = (faculty.recent_publications ?? [])
    .slice(0, MAX_PUBLICATIONS)
    .map((p) => p.title)
    .filter(Boolean)

  const parts = []
  if (faculty.title) parts.push(`${faculty.title}.`)
  if (domains.length) parts.push(`Research areas: ${domains.join(', ')}.`)
  if (publications.length) parts.push(`Recent work: ${publications.join('; ')}.`)
  return parts.join(' ')
}

// The text the user's profile is embedded from.
export function profileEmbeddingText(profile) {
  const parts = []
  if (profile.interests?.length) parts.push(`Research areas: ${profile.interests.join(', ')}.`)
  if (profile.summary) parts.push(profile.summary)
  return parts.join(' ')
}

function base64ToBytes(b64) {
  if (typeof atob === 'function') {
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return bytes
  }
  return new Uint8Array(Buffer.from(b64, 'base64'))
}

// Decodes faculty_embeddings.json into { ids, dim, matrix } where matrix is a
// row-major Float32Array of unit vectors (one row per id).
export function decodeEmbeddingIndex(json) {
  const { ids, dim, dtype, data } = json
  if (json.model && json.model !== EMBEDDING_MODEL) {
    throw new Error(`Faculty embeddings use ${json.model}, expected ${EMBEDDING_MODEL}`)
  }
  if (dim !== EMBEDDING_DIM) throw new Error(`Expected ${EMBEDDING_DIM}-dim embeddings, got ${dim}`)

  const bytes = base64ToBytes(data)
  let raw
  if (dtype === 'float32') {
    raw = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
  } else if (dtype === 'int8') {
    raw = Float32Array.from(new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength))
  } else {
    throw new Error(`Unsupported embedding dtype: ${dtype}`)
  }
  if (raw.length !== ids.length * dim) {
    throw new Error(`Embedding data has ${raw.length} values, expected ${ids.length * dim}`)
  }

  // Re-normalize every row so int8 rounding (or a pipeline that forgot to
  // normalize) can't skew cosine scores.
  const matrix = new Float32Array(raw.length)
  for (let r = 0; r < ids.length; r++) {
    const row = raw.subarray(r * dim, (r + 1) * dim)
    matrix.set(normalize(row), r * dim)
  }
  return { ids, dim, matrix }
}

export function normalize(vector) {
  let sum = 0
  for (let i = 0; i < vector.length; i++) sum += vector[i] * vector[i]
  const norm = Math.sqrt(sum) || 1
  const out = new Float32Array(vector.length)
  for (let i = 0; i < vector.length; i++) out[i] = vector[i] / norm
  return out
}

export function cosineSimilarity(a, b) {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0
}

// Scores every row of a unit-vector matrix against a query vector and returns
// [{ id, score }] sorted by score, highest first.
export function rankByCosine(query, { ids, dim, matrix }, limit = Infinity) {
  const q = normalize(query)
  const scored = ids.map((id, r) => {
    let dot = 0
    const offset = r * dim
    for (let i = 0; i < dim; i++) dot += q[i] * matrix[offset + i]
    return { id, score: dot }
  })
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit)
}

// Decodes one embeddings file (a per-university shard or the combined file)
// for large indexes: int8 rows stay as an Int8Array with a per-row inverse norm
// instead of being expanded to Float32 unit vectors, which keeps 100k faculty
// at ~40 MB of memory instead of ~150 MB. float32 files decode as before.
export function decodeEmbeddingShard(json) {
  if (json.dtype !== 'int8') return decodeEmbeddingIndex(json)
  const { ids, dim, data } = json
  if (json.model && json.model !== EMBEDDING_MODEL) {
    throw new Error(`Faculty embeddings use ${json.model}, expected ${EMBEDDING_MODEL}`)
  }
  if (dim !== EMBEDDING_DIM) throw new Error(`Expected ${EMBEDDING_DIM}-dim embeddings, got ${dim}`)
  const bytes = base64ToBytes(data)
  const int8 = new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (int8.length !== ids.length * dim) {
    throw new Error(`Embedding data has ${int8.length} values, expected ${ids.length * dim}`)
  }
  const invNorm = new Float32Array(ids.length)
  for (let r = 0; r < ids.length; r++) {
    let sum = 0
    for (let i = r * dim, end = i + dim; i < end; i++) sum += int8[i] * int8[i]
    invNorm[r] = sum ? 1 / Math.sqrt(sum) : 0
  }
  // Vector clusters (vectors/<n>.json) may list each person's university.
  return { ids, dim, int8, invNorm, institutionIds: json.institution_ids }
}

// rankByCosine across several decoded indexes (float matrices from
// decodeEmbeddingIndex or int8 shards from decodeEmbeddingShard). `allowed`
// (a Set of ids) skips everyone else.
export function rankIndexes(query, indexes, limit = Infinity, allowed = null) {
  const q = normalize(query)
  const scored = []
  for (const index of indexes) {
    const { ids, dim } = index
    const values = index.matrix ?? index.int8
    for (let r = 0; r < ids.length; r++) {
      if (allowed && !allowed.has(ids[r])) continue
      let dot = 0
      const offset = r * dim
      for (let i = 0; i < dim; i++) dot += q[i] * values[offset + i]
      scored.push({ id: ids[r], score: index.matrix ? dot : dot * index.invNorm[r], institutionId: index.institutionIds?.[r] ?? index.institutionId })
    }
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit)
}
