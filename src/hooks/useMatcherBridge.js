import { useEffect, useMemo, useState } from 'react'

const average = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length

/**
 * Maps the `useLocalAI(faculty)` object onto MatcherInterface's props and a
 * `matchScores` map for useFacultySearch. Works with the stub hook too: until
 * `ai.addDocument` exists the matcher shows "AI coming soon" and only lists
 * the files and chat locally.
 */
export default function useMatcherBridge(ai) {
  const live = typeof ai?.addDocument === 'function'

  // Files still being read; finished ones come back through ai.sources.
  const [pending, setPending] = useState([])
  const [previewMessages, setPreviewMessages] = useState([])
  const [matchesHidden, setMatchesHidden] = useState(false)

  const matches = live ? ai.matches ?? [] : []
  useEffect(() => setMatchesHidden(false), [matches])

  const matchScores = useMemo(() => {
    if (!matches.length || matchesHidden) return null
    return Object.fromEntries(matches.map((m) => [m.faculty.id, Math.max(0, m.score ?? 0)]))
  }, [matches, matchesHidden])

  const status = useMemo(() => {
    if (!live) return { state: 'unavailable' }
    if (ai.error) return { state: 'error', message: ai.error }
    const downloads = Object.values(ai.progress ?? {}).filter((p) => p != null && p < 100)
    if (downloads.length) {
      const progress = average(downloads) / 100
      return { state: 'loading', progress, message: `Downloading model ${Math.round(progress * 100)}%` }
    }
    if (ai.busy) return { state: 'working', message: ai.busy }
    const device = Object.values(ai.device ?? {}).find(Boolean)
    if (device) return { state: 'ready', message: `Model ready (${device === 'webgpu' ? 'WebGPU' : 'CPU'})` }
    return { state: 'idle', message: 'Model loads on first use' }
  }, [live, ai])

  const documents = [
    ...(live ? ai.sources ?? [] : []).map((s, i) => ({ id: `src-${i}-${s.name}`, name: s.name, status: 'done' })),
    ...pending,
  ]

  const processFiles = (files) => {
    for (const file of files) {
      const id = `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2, 7)}`
      setPending((p) => [...p, { id, name: file.name, status: live ? 'processing' : 'queued' }])
      if (!live) continue
      Promise.resolve(ai.addDocument(file))
        .then(() => setPending((p) => p.filter((d) => d.id !== id)))
        .catch((err) =>
          setPending((p) =>
            p.map((d) => (d.id === id ? { ...d, status: 'error', error: err?.message ?? String(err) } : d)),
          ),
        )
    }
  }

  const sendMessage = (text) => {
    if (live) return ai.sendMessage(text)
    setPreviewMessages((m) => [
      ...m,
      { role: 'user', content: text },
      {
        role: 'assistant',
        content: 'The in-browser model is not connected yet. Use the keyword search and filters below for now.',
      },
    ])
  }

  const messages = (live ? ai.messages ?? [] : previewMessages).map((m, i) => ({ id: `m${i}`, ...m }))

  return {
    matchScores,
    hasMatches: matches.length > 0,
    matchesHidden,
    showMatches: () => setMatchesHidden(false),
    clearMatches: () => setMatchesHidden(true),
    matcherProps: {
      status,
      documents,
      onFilesAdded: processFiles,
      // Only files that failed or are still local can be dismissed; parsed ones live in the profile.
      onRemoveDocument: (id) => setPending((p) => p.filter((d) => d.id !== id)),
      canRemoveDocument: (d) => !d.id.startsWith('src-'),
      messages,
      onSendMessage: sendMessage,
      interests: live ? ai.profile?.interests ?? [] : [],
      onRemoveInterest: live ? ai.removeInterest : undefined,
      onReset: () => {
        setPending([])
        setPreviewMessages([])
        if (live) ai.reset()
      },
      onActivate: live ? ai.preload : undefined,
      busy: false,
      accept: '.pdf,image/*,.html,.htm,.txt,.md',
    },
  }
}
