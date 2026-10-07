import { useEffect, useState } from 'react'
import { decodeEmbeddingShard, rankIndexes } from '../ai/vectors.js'
import { decodeSearchFile } from './compactRows.js'

// Loads the published data in public/data/ (layout: scripts/README.md).
//
// The catalog is faculty_search.json: one slim row per faculty member, enough
// to search, filter and draw cards (compact arrays, see compactRows.js). Full records live in one file per
// university (faculty/<id>.json) and are fetched only when the detail view
// needs them. Older builds without faculty_search.json publish a single
// faculty_index.json instead, which is used as both catalog and record store.
//
// Large builds (metadata.search_index_complete === false) keep only the most
// important people in faculty_search.json and give every university a
// search/<id>.json file with all of its rows; loadUniversityRows() fetches
// those when a visitor narrows to a country or university.

// The data ships with the site (public/data), or is hosted in a Hugging Face
// dataset when the build sets VITE_DATA_URL. The bundled copy is the fallback
// while the hosted one is unreachable or still empty.
const LOCAL_DATA_URL = `${import.meta.env.BASE_URL}data/`
const HOSTED_DATA_URL = import.meta.env.VITE_DATA_URL || ''
let dataUrlRequest = null

function dataUrl() {
  dataUrlRequest ??= (async () => {
    if (!HOSTED_DATA_URL) return LOCAL_DATA_URL
    try {
      const res = await fetch(`${HOSTED_DATA_URL}universities.json`, { method: 'HEAD', signal: AbortSignal.timeout(5000) })
      if (res.ok) return HOSTED_DATA_URL
    } catch (err) {
      console.warn('Hosted data unavailable, using the bundled copy.', err)
    }
    return LOCAL_DATA_URL
  })()
  return dataUrlRequest
}

async function fetchJson(path) {
  const res = await fetch(`${await dataUrl()}${path}`)
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
    ...row, // keeps optional fields such as the role signals (lib/roles.js)
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
const rowRequests = new Map() // institution id -> Promise<rows>
const recordFileRequests = new Map() // record_file path -> Promise<void>
let catalogPromise = null
let uniById = new Map()
let catalogPartial = false
let vectorsInfo = null // metadata.vectors: { k, dim, model, count } when vectors/ is published
let centroidsRequest = null
const clusterRequests = new Map() // cluster number -> Promise<decoded shard>

export function loadCatalog() {
  catalogPromise ??= (async () => {
    const [universities, domains, metadata] = await Promise.all([
      tryJson('universities.json', []),
      tryJson('domains.json', []),
      tryJson('metadata.json', {}),
    ])
    uniById = new Map(universities.map((u) => [u.id, u]))
    const uniByName = new Map(universities.map((u) => [u.name, u]))
    vectorsInfo = metadata?.vectors?.k ? metadata.vectors : null

    const search = await tryJson('faculty_search.json', null).then((json) => (json ? decodeSearchFile(json) : null))
    if (Array.isArray(search)) {
      const rows = search.map((r) => rowFromSearch(r, uniById))
      catalogPartial = metadata?.search_index_complete === false && universities.some((u) => u.search_file)
      const published = universities.reduce((n, u) => n + (u.faculty_count ?? 0), 0)
      return { rows, universities, domains, partial: catalogPartial, totalRows: Math.max(published, rows.length) }
    }
    const index = await fetchJson('faculty_index.json')
    const rows = index.map((r) => rowFromRecord(r, uniById, uniByName))
    rows.forEach((r) => records.set(r.id, r))
    return { rows, universities, domains, partial: false, totalRows: rows.length }
  })()
  catalogPromise.catch(() => {
    catalogPromise = null
  })
  return catalogPromise
}

/**
 * Every search row for the given universities (their search/<id>.json files),
 * for catalogs that only hold the most important people. Universities without
 * a search file resolve to no rows; failed downloads are retried next time.
 */
export async function loadUniversityRows(institutionIds) {
  await loadCatalog()
  const unis = institutionIds.map((id) => uniById.get(id)).filter((u) => u?.search_file)
  const lists = []
  let next = 0
  const worker = async () => {
    while (next < unis.length) {
      const uni = unis[next++]
      if (!rowRequests.has(uni.id)) {
        const request = fetchJson(uni.search_file).then((json) => decodeSearchFile(json).map((r) => rowFromSearch(r, uniById)))
        request.catch(() => rowRequests.delete(uni.id))
        rowRequests.set(uni.id, request)
      }
      try {
        lists.push(await rowRequests.get(uni.id))
      } catch (err) {
        console.warn(`Researchers at ${uni.name} unavailable`, err)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, unis.length) }, worker))
  return lists.flat()
}

// Large builds can split a university's full records into chunks; each
// search row then names its chunk as record_file.
function loadRecordFile(path) {
  if (!recordFileRequests.has(path)) {
    const request = fetchJson(path).then((list) => {
      for (const r of list) records.set(r.id, rowFromRecord(r, uniById, new Map()))
    })
    request.catch(() => recordFileRequests.delete(path))
    recordFileRequests.set(path, request)
  }
  return recordFileRequests.get(path)
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
  if (!records.has(row.id)) await (row.record_file ? loadRecordFile(row.record_file) : loadUniversity(row.institution?.id))
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
    const request = fetchJson(uni.embeddings_file).then((data) => ({ ...decodeEmbeddingShard(data), institutionId: uni.id }))
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

/** True when every given university has its own embeddings file (exact and smaller than clusters). */
export async function hasEmbeddingShards(institutionIds) {
  await loadCatalog()
  return institutionIds.every((id) => uniById.get(id)?.embeddings_file)
}

/** True when the build publishes clustered vectors (vectors/), searched with searchVectors(). */
export async function hasVectorIndex() {
  await loadCatalog()
  return Boolean(vectorsInfo)
}

// Clustered vectors (an inverted-file index): vectors/centroids.json holds one
// int8 centroid per cluster and vectors/<n>.json the people nearest to it.
// A search ranks the centroids, then only the closest clusters' people.
function loadCentroids() {
  centroidsRequest ??= fetchJson('vectors/centroids.json').then((json) =>
    decodeEmbeddingShard({ ...json, ids: Array.from({ length: json.k }, (_, i) => i) }),
  )
  centroidsRequest.catch(() => {
    centroidsRequest = null
  })
  return centroidsRequest
}

function loadCluster(n) {
  if (!clusterRequests.has(n)) {
    const request = fetchJson(`vectors/${n}.json`).then(decodeEmbeddingShard)
    request.catch(() => clusterRequests.delete(n))
    clusterRequests.set(n, request)
  }
  return clusterRequests.get(n)
}

const PROBE_START = 24 // clusters searched first
const PROBE_MAX = 192 // widest search when a filter leaves few people per cluster
const ENOUGH_FILTERED = 200 // a filtered search stops widening once it has this many

/**
 * The `limit` people closest to `query` from vectors/, limited to `allowed`
 * ids when given. Starts with the closest PROBE_START clusters and widens
 * while fewer than `limit` (with a filter, ENOUGH_FILTERED) people are found.
 * -> [{ id, score, institutionId? }] best first
 */
export async function searchVectors(query, { allowed = null, limit = 1000, onProgress } = {}) {
  const centroids = await loadCentroids()
  const order = rankIndexes(query, [centroids]).map((c) => c.id)
  let probe = Math.min(PROBE_START, order.length)
  let loaded = 0
  let done = 0
  const clusters = []
  for (;;) {
    const wanted = order.slice(loaded, probe)
    let next = 0
    const worker = async () => {
      while (next < wanted.length) {
        const n = wanted[next++]
        try {
          clusters.push(await loadCluster(n))
        } catch (err) {
          console.warn(`Vector cluster ${n} unavailable`, err)
        }
        onProgress?.({ done: ++done, total: probe })
      }
    }
    await Promise.all(Array.from({ length: Math.min(6, wanted.length) }, worker))
    loaded = probe
    const ranked = rankIndexes(query, clusters, limit, allowed)
    const enough = allowed ? Math.min(limit, ENOUGH_FILTERED) : limit
    if (ranked.length >= enough || probe >= Math.min(PROBE_MAX, order.length)) return ranked
    probe = Math.min(probe * 2, PROBE_MAX, order.length)
  }
}

// Vectors the matcher downloads when no university is picked on a large
// build: about 50 MB, enough for the top universities' people.
const MATCH_ALL_LIMIT = 100_000

/**
 * Universities the AI matcher ranks against when no country or university is
 * picked: all of them, or on a large build the best-ranked ones up to
 * MATCH_ALL_LIMIT people. -> { institutionIds (null = all), universities, totalUniversities }
 */
export async function defaultMatchScope() {
  await loadCatalog()
  const unis = [...uniById.values()].filter((u) => u.embeddings_file)
  const people = unis.reduce((n, u) => n + (u.faculty_count ?? 0), 0)
  if (!catalogPartial || people <= MATCH_ALL_LIMIT) {
    return { institutionIds: null, universities: unis.length, totalUniversities: unis.length }
  }
  const picked = []
  let count = 0
  for (const u of unis.sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999))) {
    if (picked.length && count + (u.faculty_count ?? 0) > MATCH_ALL_LIMIT) break
    picked.push(u.id)
    count += u.faculty_count ?? 0
  }
  return { institutionIds: picked, universities: picked.length, totalUniversities: unis.length }
}

/** Full records already in memory, for embedding in the browser when no vectors are published. */
export const cachedRecords = (ids) => ids.map((id) => records.get(id)).filter(Boolean)
