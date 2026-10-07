import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { cachedRecords, defaultMatchScope, hasEmbeddingShards, hasVectorIndex, loadEmbeddings, searchVectors } from '../data/facultyStore.js'
import { fetchOpenAlexProfile } from '../ai/openalexProfile.js'
import { documentKind, extractDocumentText } from '../ai/documentText.js'
import {
  EMPTY_PROFILE,
  buildChatMessages,
  dedupeInterests,
  mergeProfiles,
  parseModelProfile,
  quickProfile,
  topicsFromText,
} from '../ai/profile.js'
import { EMBEDDING_DIM } from '../ai/config.js'
import { rankEvidence, sharedInterests } from '../ai/explain.js'
import { facultyEmbeddingText, profileEmbeddingText, rankIndexes } from '../ai/vectors.js'

// In-browser matching: an upload is turned into a profile without a language
// model (quickProfile), MiniLM embeds it, and faculty are ranked by cosine
// similarity, so the first match needs only the ~23 MB embedding model. Chat
// messages are read by Qwen2.5-0.5B-Instruct, which downloads (a few hundred MB)
// the first time someone sends one. Nothing leaves the browser except model
// downloads from the Hugging Face Hub (cached by the browser after the first visit).
//
// const ai = useLocalAI(faculty, { institutionIds })
//   faculty           catalog rows (useFacultySearch().faculty); matches point at these
//   institutionIds    universities whose embedding shards to rank against, null = all
//   ai.profile        { interests: string[], summary: string, text: string }  (text = research text from uploads)
//   ai.matches        [{ faculty, score }] best first, [] until a profile exists
//   ai.missingInstitutionIds  universities of matches whose rows aren't in `faculty` yet
//   ai.matchScope     { universities, totalUniversities } when matching without a
//                     filter covers only the top universities (large builds), else null
//   ai.messages       chat transcript [{ role: 'user' | 'assistant', content }]
//   ai.sources        processed uploads [{ name, kind, interests }]
//   ai.busy           what is running now ('Reading resume.pdf…') or null
//   ai.progress       { chat, embedding } download progress, 0-100 or null
//   ai.device         { chat, embedding } e.g. 'webgpu' or 'wasm', once loaded
//   ai.error          last error message or null
//   ai.addDocument(file)      PDF, image (OCR), HTML or text
//   ai.addText(text, name?)   pasted profile or CV text
//   ai.sendMessage(text)      chat input, merged into the profile
//   ai.removeInterest(topic) / ai.setInterests(list) / ai.reset()
//   ai.explain(record)        { areas, papers, shared } closest to the profile, or null (see ai/explain.js)
//   ai.preload(models?)       start model downloads early (default: the embedding model only)

let workerInstance = null
let nextRequestId = 1
const pending = new Map()
const listeners = new Set()

function getWorker() {
  if (!workerInstance) {
    workerInstance = new Worker(new URL('../ai/localAI.worker.js', import.meta.url), { type: 'module' })
    workerInstance.addEventListener('message', ({ data }) => {
      const request = data.id != null ? pending.get(data.id) : null
      if (data.type === 'result' || data.type === 'error') {
        if (!request) return
        pending.delete(data.id)
        if (data.type === 'result') request.resolve(data.result)
        else request.reject(new Error(data.error))
      } else if (data.type === 'embed-progress') {
        request?.onProgress?.(data)
      } else {
        listeners.forEach((fn) => fn(data))
      }
    })
  }
  return workerInstance
}

function callWorker(message, onProgress) {
  const id = nextRequestId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress })
    getWorker().postMessage({ ...message, id })
  })
}

async function embedTexts(texts, onProgress) {
  return callWorker({ type: 'embed', texts }, onProgress)
}

// Ranking keeps only the best matches; the results list shows these.
const MAX_MATCHES = 1000

// Precomputed vectors from the data pipeline (one shard per university, or
// the single faculty_embeddings.json), or embeddings computed here for the
// full records in memory when neither is published.
async function loadFacultyIndex(faculty, institutionIds, { onShards, onEmbed }) {
  const known = new Set(faculty.map((f) => f.id))
  try {
    const shards = await loadEmbeddings(institutionIds, onShards)
    if (shards && institutionIds && !shards.length) return []
    if (shards?.some((s) => s.ids.some((id) => known.has(id)))) return shards
  } catch (err) {
    console.warn('Precomputed faculty embeddings unavailable, embedding in the browser.', err)
  }
  const records = cachedRecords(faculty.map((f) => f.id))
  if (!records.length) throw new Error('Faculty vectors are not published yet.')
  const matrix = await embedTexts(records.map(facultyEmbeddingText), onEmbed)
  return [{ ids: records.map((f) => f.id), dim: matrix.length / records.length, matrix }]
}

const NO_FACULTY = []

export default function useLocalAI(faculty = NO_FACULTY, { institutionIds = null } = {}) {
  const [profile, setProfile] = useState(EMPTY_PROFILE)
  const [sources, setSources] = useState([])
  const [messages, setMessages] = useState([])
  const [ranked, setRanked] = useState([])
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)
  const [progress, setProgress] = useState({ chat: null, embedding: null })
  const [device, setDevice] = useState({ chat: null, embedding: null })
  const [matchScope, setMatchScope] = useState(null)

  const indexRef = useRef(null)
  const profileRef = useRef(profile)
  profileRef.current = profile

  useEffect(() => {
    const onEvent = (data) => {
      if (data.type === 'progress') setProgress((p) => ({ ...p, [data.model]: Math.round(data.progress) }))
      if (data.type === 'device') setDevice((d) => ({ ...d, [data.model]: data.device }))
    }
    listeners.add(onEvent)
    return () => listeners.delete(onEvent)
  }, [])

  // A new faculty list (e.g. once the JSON loads) invalidates the index.
  useEffect(() => {
    indexRef.current = null
  }, [faculty])
  const scopeKey = institutionIds ? [...institutionIds].sort().join(',') : '*'

  // Tasks can overlap (re-ranking while a document is read), so busy clears
  // only when the last one finishes.
  const activeTasks = useRef(0)
  const run = useCallback(async (label, task) => {
    activeTasks.current++
    setBusy(label)
    setError(null)
    try {
      return await task()
    } catch (err) {
      setError(err.message ?? String(err))
      return null
    } finally {
      if (--activeTasks.current === 0) setBusy(null)
    }
  }, [])

  const addText = useCallback(
    (text, name = 'Pasted text') =>
      run(`Reading ${name}…`, async () => {
        const extracted = quickProfile(text)
        if (!extracted.text) throw new Error(`No research text found in ${name}.`)
        setSources((s) => [...s, { name, kind: 'text', interests: extracted.interests }])
        setProfile((p) => mergeProfiles(p, extracted))
        return extracted
      }),
    [run],
  )

  const addDocument = useCallback(
    (file) =>
      run(`Reading ${file.name}…`, async () => {
        const text = await extractDocumentText(file)
        const extracted = quickProfile(text)
        if (!extracted.text) throw new Error(`No research text found in ${file.name}.`)
        setSources((s) => [...s, { name: file.name, kind: documentKind(file), interests: extracted.interests }])
        setProfile((p) => mergeProfiles(p, extracted))
        return extracted
      }),
    [run],
  )

  const addOpenAlexProfile = useCallback(
    (input) =>
      run('Reading your OpenAlex profile…', async () => {
        const { name, interests, text } = await fetchOpenAlexProfile(input)
        setSources((s) => [...s, { name: `${name} (OpenAlex)`, kind: 'openalex', interests }])
        setProfile((p) => mergeProfiles(p, { interests, summary: '', text }))
        return { interests, text }
      }),
    [run],
  )

  const sendMessage = useCallback(
    (text) => {
      if (!text?.trim()) return Promise.resolve(null)
      setMessages((m) => [...m, { role: 'user', content: text }])
      return run('Thinking…', async () => {
        let parsed = { interests: [], summary: '', reply: '' }
        try {
          const output = await callWorker({
            type: 'generate',
            messages: buildChatMessages(profileRef.current, text),
          })
          parsed = parseModelProfile(output)
        } catch (err) {
          setError(err.message ?? String(err))
        }
        // If the model failed or returned nothing usable, take topics straight
        // from what the user typed so their input is never lost.
        const added = parsed.interests.length ? parsed.interests : topicsFromText(text)
        setProfile((p) => mergeProfiles(p, { interests: added, summary: parsed.summary }))
        const reply =
          parsed.reply ||
          (added.length ? `Added ${added.join(', ')} to your interests.` : 'I didn’t find new research topics in that.')
        setMessages((m) => [...m, { role: 'assistant', content: reply }])
        return added
      })
    },
    [run],
  )

  const removeInterest = useCallback((topic) => {
    setProfile((p) => ({ ...p, interests: p.interests.filter((t) => t.toLowerCase() !== topic.toLowerCase()) }))
  }, [])

  const setInterests = useCallback((list) => {
    setProfile((p) => ({ ...p, interests: dedupeInterests(list) }))
  }, [])

  const reset = useCallback(() => {
    setProfile(EMPTY_PROFILE)
    setSources([])
    setMessages([])
    setRanked([])
    setError(null)
  }, [])

  const preload = useCallback(
    (models = ['embedding']) => callWorker({ type: 'load', models }).catch((err) => setError(err.message)),
    [],
  )

  // Re-rank whenever the profile changes.
  const queryText = profileEmbeddingText(profile)
  useEffect(() => {
    if (!queryText || !faculty.length) {
      setRanked((r) => (r.length ? [] : r))
      return
    }
    let cancelled = false
    // How to rank against the current scope: the picked universities' own
    // embedding files when they exist, else clustered vectors (vectors/) when
    // published, else per-university shards as far as they go.
    const buildRanker = async () => {
      const useShards = institutionIds?.length && (await hasEmbeddingShards(institutionIds))
      if (!useShards && (await hasVectorIndex())) {
        if (!cancelled) setMatchScope(null)
        const wanted = institutionIds ? new Set(institutionIds) : null
        const allowed = wanted ? new Set(faculty.filter((f) => wanted.has(f.institution?.id)).map((f) => f.id)) : null
        return (query) =>
          searchVectors(query, {
            allowed,
            limit: MAX_MATCHES,
            onProgress: ({ done, total }) => setBusy(`Loading researcher vectors ${done}/${total}…`),
          })
      }
      // Without a filter, large builds match against the top universities only.
      const scope = institutionIds ? null : await defaultMatchScope()
      const ids = scope ? scope.institutionIds : institutionIds
      if (!cancelled) setMatchScope(scope?.institutionIds ? scope : null)
      const shards = await loadFacultyIndex(faculty, ids, {
        onShards: ({ done, total }) => setBusy(`Loading researcher vectors ${done}/${total}…`),
        onEmbed: ({ done, total }) => setBusy(`Indexing researchers ${done}/${total}…`),
      })
      return async (query) => rankIndexes(query, shards, MAX_MATCHES)
    }
    run('Matching researchers…', async () => {
      if (indexRef.current?.key !== scopeKey) {
        indexRef.current = { key: scopeKey, rank: await buildRanker() }
      }
      const query = await embedTexts([queryText])
      const ranked = await indexRef.current.rank(query)
      if (!cancelled) setRanked(ranked)
    })
    return () => {
      cancelled = true
    }
    // institutionIds is read through scopeKey so a new array with the same ids doesn't re-rank.
  }, [queryText, faculty, scopeKey, run])

  // Why a researcher matches: their research areas and paper titles embedded next to the profile.
  const explain = useCallback(
    async (record) => {
      if (!queryText || !record) return null
      const weights = Object.entries(record.domain_weights ?? {}).sort((a, b) => b[1] - a[1])
      const areas = weights.map(([name]) => name).slice(0, 6)
      if (record.primary_domain && !areas.includes(record.primary_domain)) areas.unshift(record.primary_domain)
      const papers = (record.recent_publications ?? []).filter((p) => p.title)
      if (!areas.length && !papers.length) return null
      const matrix = await embedTexts([queryText, ...areas, ...papers.map((p) => p.title)])
      const texts = [...areas, ...papers.map((p) => p.title)]
      return {
        ...rankEvidence({ dim: EMBEDDING_DIM, matrix, areas, papers }),
        shared: sharedInterests(profileRef.current.interests, texts),
      }
    },
    [queryText],
  )

  const byId = useMemo(() => new Map(faculty.map((f) => [f.id, f])), [faculty])
  const matches = useMemo(
    () => ranked.filter((r) => byId.has(r.id)).map((r) => ({ faculty: byId.get(r.id), score: r.score })),
    [ranked, byId],
  )
  // On large builds the catalog holds only the most important people, so the
  // site loads these universities' rows to show every match.
  const missingInstitutionIds = useMemo(() => {
    const ids = new Set()
    for (const r of ranked) if (r.institutionId && !byId.has(r.id)) ids.add(r.institutionId)
    return [...ids]
  }, [ranked, byId])

  return {
    profile,
    matches,
    missingInstitutionIds,
    matchScope,
    messages,
    sources,
    busy,
    error,
    progress,
    device,
    addDocument,
    addText,
    addOpenAlexProfile,
    sendMessage,
    removeInterest,
    setInterests,
    reset,
    preload,
    explain,
  }
}
