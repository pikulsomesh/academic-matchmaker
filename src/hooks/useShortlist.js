import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { STORAGE_KEY, newEntry, readShortlist, writeShortlist } from '../lib/shortlist.js'

/**
 * The visitor's shortlist (lib/shortlist.js), persisted in localStorage and kept
 * in step across open tabs. `saved` is false when the browser won't store it.
 */
export default function useShortlist() {
  const [entries, setEntries] = useState(() => readShortlist())
  const [saved, setSaved] = useState(true)
  const current = useRef(entries) // latest list, so changes in one event handler don't overwrite each other

  useEffect(() => {
    const onStorage = (e) => {
      if (e.key !== STORAGE_KEY && e.key !== null) return
      current.current = readShortlist()
      setEntries(current.current)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const change = useCallback((fn) => {
    current.current = fn(current.current)
    setEntries(current.current)
    setSaved(writeShortlist(current.current))
  }, [])

  const ids = useMemo(() => new Set(entries.map((e) => e.id)), [entries])
  const toggle = useCallback(
    (row) => change((prev) => (prev.some((e) => e.id === row.id) ? prev.filter((e) => e.id !== row.id) : [newEntry(row), ...prev])),
    [change],
  )
  const update = useCallback(
    (id, patch) => change((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e))),
    [change],
  )
  const remove = useCallback((id) => change((prev) => prev.filter((e) => e.id !== id)), [change])

  return { entries, ids, saved, toggle, update, remove }
}
