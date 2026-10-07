import { useEffect, useState } from 'react'
import { decodeEmbeddingShard } from '../ai/vectors.js'

// Loads the published data in public/data/ (layout: scripts/README.md).
//
// The catalog is faculty_search.json: one slim row per faculty member, enough
// to search, filter and draw cards. Full records live in one file per
// university (faculty/<id>.json) and are fetched only when the detail view
// needs them. Older builds without faculty_search.json publish a single
// faculty_index.json instead, which is used as both catalog and record store.

const DATA_URL = `${import.meta.env.BASE_URL}data/`

async function fetchJson(path) {
  const res = await fetch(`${DATA_URL}${path}`)
  const type = res.headers.get('content-type') ?? ''
  // Vite's dev server answers missing files with index.html.
  if (!res.ok || type.includes('text/html')) throw new Error(`${path}: ${res.status}`)
  return res.json()
}

const tryJson = (path, fallback) => fetchJson(path).catch(() => fallback)

// Domain names strongest first, primary domain included.
function domainsOf(record) {
  const names = Object.entries(record.domain_weights ?? {})
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => name)
  if (record.primary_domain && !names.includes(record.primary_domain)) names.unshift(record.primary_domain)
  return names
}

function institutionFor(uni, fallback = {}) {
  return {
    id: uni?.id ?? fallback.id,
    name: uni?.name ?? fallback.name,
    country_code: uni?.country_code ?? fallback.country_code,
    rank: uni?.rank ?? fallback.rank,
  }
}

// Card-ready shape shared by slim rows and full records.
function rowFromSearch(row, uniById) {
  const uni = uniById.get(row.institution_id)
  const domains = row.domains?.length ? [...row.domains] : []
  if (row.primary_domain && !domains.includes(row.primary_domain)) domains.unshift(row.primary_domain)
  return {
    id: row.id,
    name: row.name,
    title: row.title,
    email: row.email ?? null,
    profile_url: row.profile_url ?? null,
    has_email: row.has_email ?? Boolean(row.email),
    primary_domain: row.primary_domain,
    domains,
    citation_count: row.citation_count ?? 0,
    institution: institutionFor(uni, { id: row.institution_id }),
  }
}

function rowFromRecord(record, uniById, uniByName) {
  const inst = record.institution ?? {}
  const uni = uniById.get(inst.id) ?? uniByName.get(inst.name)
  return {
    ...record,
    has_email: Boolean(record.email),
    domains: domainsOf(record),
    institution: institutionFor(uni, inst),
    full: true,
  }
}

const records = new Map() // faculty id -> full record (row shape, full: true)
const shardRequests = new Map() // institution id -> Promise<void>
const embeddingRequests = new Map() // institution id -> Promise<decoded shard | null>
let catalogPromise = null
let uniById = new Map()

export function loadCatalog() {
  catalogPromise ??= (async () => {
    const [universities, domains] = await Promise.all([tryJson('universities.json', []), tryJson('domains.json', [])])
    uniById = new Map(universities.map((u) => [u.id, u]))
    const uniByName = new Map(universities.map((u) => [u.name, u]))

    const search = await tryJson('faculty_search.json', null)
    if (Array.isArray(search)) {
      return { rows: search.map((r) => rowFromSearch(r, uniById)), universities, domains }
    }
    const index = await fetchJson('faculty_index.json')
    const rows = index.map((r) => rowFromRecord(r, uniById, uniByName))
    rows.forEach((r) => records.set(r.id, r))
    return { rows, universities, domains }
  })()
  catalogPromise.catch(() => {
    catalogPromise = null
  })
  return catalogPromise
}

function loadUniversity(institutionId) {
  const uni = uniById.get(institutionId)
  if (!uni?.faculty_file) return Promise.resolve()
  if (!shardRequests.has(institutionId)) {
    const uniByName = new Map([[uni.name, uni]])
    const request = fetchJson(uni.faculty_file).then((list) => {
      for (const r of list) records.set(r.id, rowFromRecord(r, uniById, uniByName))
    })
    request.catch(() => shardRequests.delete(institutionId))
    shardRequests.set(institutionId, request)
  }
  return shardRequests.get(institutionId)
}

export const cachedRecord = (id) => records.get(id) ?? null

export async function loadRecord(row) {
  if (!records.has(row.id)) await loadUniversity(row.institution?.id)
  return records.get(row.id) ?? null
}

/** The full record for a catalog row: the row itself until the university file arrives. */
export function useFullRecord(row) {
  const [record, setRecord] = useState(() => (row ? cachedRecord(row.id) : null))
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!row) return
    let live = true
    setFailed(false)
    setRecord(cachedRecord(row.id))
    loadRecord(row)
      .then((r) => live && setRecord(r))
      .catch(() => live && setFailed(true))
    return () => {
      live = false
    }
  }, [row])
  return { faculty: record ? { ...row, ...record } : row, loading: Boolean(row) && !record && !failed }
}

function loadEmbeddingShard(uni) {
  if (!embeddingRequests.has(uni.id)) {
    const request = fetchJson(uni.embeddings_file).then(decodeEmbeddingShard)
    request.catch(() => embeddingRequests.delete(uni.id))
    embeddingRequests.set(uni.id, request)
  }
  return embeddingRequests.get(uni.id)
}

/**
 * Precomputed faculty vectors for the given universities (all when
 * `institutionIds` is null), as decoded shards for rankIndexes(). Falls back
 * to the single faculty_embeddings.json file; resolves to null when neither
 * is published.
 */
export async function loadEmbeddings(institutionIds, onProgress) {
  await loadCatalog()
  const wanted = institutionIds ? new Set(institutionIds) : null
  const unis = [...uniById.values()].filter((u) => u.embeddings_file && (!wanted || wanted.has(u.id)))
  if (!unis.length) {
    if ([...uniById.values()].some((u) => u.embeddings_file)) return []
    if (!embeddingRequests.has('*')) {
      const request = fetchJson('faculty_embeddings.json').then(decodeEmbeddingShard)
      request.catch(() => embeddingRequests.delete('*'))
      embeddingRequests.set('*', request)
    }
    try {
      return [await embeddingRequests.get('*')]
    } catch {
      return null
    }
  }

  // A few downloads at a time keeps the page responsive on slow connections.
  const shards = []
  let done = 0
  let next = 0
  const worker = async () => {
    while (next < unis.length) {
      const uni = unis[next++]
      try {
        shards.push(await loadEmbeddingShard(uni))
      } catch (err) {
        console.warn(`Embeddings for ${uni.name} unavailable`, err)
      }
      onProgress?.({ done: ++done, total: unis.length })
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, unis.length) }, worker))
  return shards
}

/** Full records already in memory, for embedding in the browser when no vectors are published. */
export const cachedRecords = (ids) => ids.map((id) => records.get(id)).filter(Boolean)
