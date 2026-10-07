import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FACULTY_EMBEDDINGS_PATH } from '../ai/config.js'
import { documentKind, extractDocumentText } from '../ai/documentText.js'
import {
  EMPTY_PROFILE,
  buildChatMessages,
  buildExtractionMessages,
  dedupeInterests,
  mergeProfiles,
  parseModelProfile,
  topicsFromText,
} from '../ai/profile.js'
import { decodeEmbeddingIndex, facultyEmbeddingText, profileEmbeddingText, rankByCosine } from '../ai/vectors.js'

// In-browser matching: Qwen2.5-0.5B-Instruct reads uploads and chat messages
// into an interest profile, MiniLM embeds it, and faculty are ranked by cosine
// similarity. Nothing leaves the browser except model downloads from the
// Hugging Face Hub (cached by the browser after the first visit).
//
// const ai = useLocalAI(faculty)
//   ai.profile        { interests: string[], summary: string }
//   ai.matches        [{ faculty, score }] best first, [] until a profile exists
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
//   ai.preload()              start model downloads early (optional)

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

// Precomputed vectors from the data pipeline, or embeddings computed here
// for the loaded faculty when that file isn't published yet.
async function loadFacultyIndex(faculty, onProgress) {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}${FACULTY_EMBEDDINGS_PATH}`)
    if (res.ok && res.headers.get('content-type')?.includes('json')) {
      const index = decodeEmbeddingIndex(await res.json())
      const known = new Set(faculty.map((f) => f.id))
      if (index.ids.some((id) => known.has(id))) return index
    }
  } catch (err) {
    console.warn('Precomputed faculty embeddings unavailable, embedding in the browser.', err)
  }
  const matrix = await embedTexts(faculty.map(facultyEmbeddingText), onProgress)
  return { ids: faculty.map((f) => f.id), dim: matrix.length / Math.max(faculty.length, 1), matrix }
}

const NO_FACULTY = []

export default function useLocalAI(faculty = NO_FACULTY) {
  const [profile, setProfile] = useState(EMPTY_PROFILE)
  const [sources, setSources] = useState([])
  const [messages, setMessages] = useState([])
  const [ranked, setRanked] = useState([])
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)
  const [progress, setProgress] = useState({ chat: null, embedding: null })
  const [device, setDevice] = useState({ chat: null, embedding: null })

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

  const extractProfile = useCallback(async (text) => {
    const output = await callWorker({ type: 'generate', messages: buildExtractionMessages(text) })
    return parseModelProfile(output)
  }, [])

  const addText = useCallback(
    (text, name = 'Pasted text') =>
      run(`Reading ${name}…`, async () => {
        if (!text?.trim()) throw new Error(`No readable text found in ${name}.`)
        const extracted = await extractProfile(text)
        setSources((s) => [...s, { name, kind: 'text', interests: extracted.interests }])
        setProfile((p) => mergeProfiles(p, extracted))
        return extracted
      }),
    [run, extractProfile],
  )

  const addDocument = useCallback(
    (file) =>
      run(`Reading ${file.name}…`, async () => {
        const text = await extractDocumentText(file)
        if (!text?.trim()) throw new Error(`No readable text found in ${file.name}.`)
        const extracted = await extractProfile(text)
        setSources((s) => [...s, { name: file.name, kind: documentKind(file), interests: extracted.interests }])
        setProfile((p) => mergeProfiles(p, extracted))
        return extracted
      }),
    [run, extractProfile],
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
    (models = ['embedding', 'chat']) => callWorker({ type: 'load', models }).catch((err) => setError(err.message)),
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
    run('Matching faculty…', async () => {
      if (!indexRef.current) {
        indexRef.current = await loadFacultyIndex(faculty, ({ done, total }) =>
          setBusy(`Indexing faculty ${done}/${total}…`),
        )
      }
      const query = await embedTexts([queryText])
      if (!cancelled) setRanked(rankByCosine(query, indexRef.current))
    })
    return () => {
      cancelled = true
    }
  }, [queryText, faculty, run])

  const matches = useMemo(() => {
    const byId = new Map(faculty.map((f) => [f.id, f]))
    return ranked.filter((r) => byId.has(r.id)).map((r) => ({ faculty: byId.get(r.id), score: r.score }))
  }, [ranked, faculty])

  return {
    profile,
    matches,
    messages,
    sources,
    busy,
    error,
    progress,
    device,
    addDocument,
    addText,
    sendMessage,
    removeInterest,
    setInterests,
    reset,
    preload,
  }
}
