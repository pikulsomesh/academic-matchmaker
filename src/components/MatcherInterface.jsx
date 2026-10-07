import { useEffect, useRef, useState } from 'react'
import { Bot, FileText, LoaderCircle, Send, Sparkles, Trash2, Upload, X } from 'lucide-react'

/**
 * Presentational matcher: a drop zone for resumes / Scholar screenshots /
 * LinkedIn exports plus a chat input. It owns no AI logic; the local AI hook
 * drives it through these props.
 *
 * @param {object}   props
 * @param {{state: 'idle'|'loading'|'ready'|'working'|'error'|'unavailable', message?: string, progress?: number}} props.status
 *        Model status. `progress` (0–1) renders a bar while state is 'loading'.
 * @param {Array<{id: string, name: string, status: 'queued'|'processing'|'done'|'error', error?: string}>} props.documents
 * @param {(files: File[]) => void} props.onFilesAdded  Called with dropped or picked files.
 * @param {(id: string) => void}    props.onRemoveDocument
 * @param {Array<{id: string, role: 'user'|'assistant', content: string}>} props.messages
 * @param {(text: string) => void}  props.onSendMessage
 * @param {string[]}                props.interests     Merged research interests extracted so far.
 * @param {(interest: string) => void} props.onRemoveInterest
 * @param {() => void}              props.onFindMatches  Embed interests and rank faculty.
 * @param {() => void}              props.onReset        Clear documents, chat and matches.
 * @param {boolean}                 props.busy           Disable inputs while a job runs.
 * @param {string}                  props.accept         File input accept list.
 */
export default function MatcherInterface({
  status = { state: 'idle' },
  documents = [],
  onFilesAdded = () => {},
  onRemoveDocument = () => {},
  messages = [],
  onSendMessage = () => {},
  interests = [],
  onRemoveInterest,
  onFindMatches = () => {},
  onReset,
  busy = false,
  accept = '.pdf,.txt,.png,.jpg,.jpeg,.webp',
}) {
  const [dragging, setDragging] = useState(false)
  const [draft, setDraft] = useState('')
  const fileInput = useRef(null)
  const chatEnd = useRef(null)

  useEffect(() => {
    chatEnd.current?.scrollIntoView({ block: 'nearest' })
  }, [messages.length])

  const addFiles = (list) => {
    const files = [...(list ?? [])]
    if (files.length) onFilesAdded(files)
  }

  const onDrop = (e) => {
    e.preventDefault()
    setDragging(false)
    if (!busy) addFiles(e.dataTransfer.files)
  }

  const send = (e) => {
    e.preventDefault()
    const text = draft.trim()
    if (!text || busy) return
    onSendMessage(text)
    setDraft('')
  }

  const hasInput = documents.length > 0 || messages.length > 0 || interests.length > 0

  return (
    <section className="overflow-hidden rounded-2xl border border-gray-100 bg-white shadow-sm">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-gray-100 px-5 py-4 sm:px-6">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight text-charcoal">
            <Sparkles className="h-5 w-5 text-cardinal" /> Find your matches
          </h2>
          <p className="mt-0.5 text-sm text-mit-gray">
            Upload a resume or profile and describe your interests. Everything runs privately in your browser.
          </p>
        </div>
        <StatusPill status={status} />
      </header>

      {status.state === 'loading' && typeof status.progress === 'number' && (
        <div className="h-1 bg-gray-100">
          <div
            className="h-full bg-cardinal transition-all"
            style={{ width: `${Math.round(Math.min(1, status.progress) * 100)}%` }}
          />
        </div>
      )}

      <div className="grid gap-5 p-5 sm:p-6 lg:grid-cols-2">
        {/* Drop zone */}
        <div className="flex flex-col gap-3">
          <div
            role="button"
            tabIndex={0}
            aria-disabled={busy}
            onClick={() => !busy && fileInput.current?.click()}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && !busy && (e.preventDefault(), fileInput.current?.click())}
            onDragOver={(e) => {
              e.preventDefault()
              setDragging(true)
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={`flex min-h-[11rem] flex-1 cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-6 text-center transition focus:outline-none focus-visible:ring-2 focus-visible:ring-cardinal/40 ${
              dragging ? 'border-cardinal bg-cardinal/5' : 'border-gray-200 hover:border-cardinal/40 hover:bg-gray-50/60'
            } ${busy ? 'cursor-not-allowed opacity-60' : ''}`}
          >
            <span className="flex h-11 w-11 items-center justify-center rounded-full bg-cardinal/10 text-cardinal">
              <Upload className="h-5 w-5" />
            </span>
            <p className="text-sm font-medium text-charcoal">
              Drop files here or <span className="text-cardinal underline-offset-2 hover:underline">browse</span>
            </p>
            <p className="text-xs text-mit-gray">PDF resume, Google Scholar screenshot or LinkedIn profile</p>
            <input
              ref={fileInput}
              type="file"
              multiple
              accept={accept}
              className="hidden"
              onChange={(e) => {
                addFiles(e.target.files)
                e.target.value = ''
              }}
            />
          </div>

          {documents.length > 0 && (
            <ul className="space-y-2">
              {documents.map((d) => (
                <li
                  key={d.id}
                  className="flex items-center gap-3 rounded-xl border border-gray-100 px-3 py-2 text-sm"
                >
                  <FileText className="h-4 w-4 shrink-0 text-mit-gray" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-charcoal">{d.name}</span>
                    {d.status === 'error' && d.error && <span className="block text-xs text-cardinal">{d.error}</span>}
                  </span>
                  <DocStatus status={d.status} />
                  <button
                    type="button"
                    onClick={() => onRemoveDocument(d.id)}
                    aria-label={`Remove ${d.name}`}
                    className="rounded-md p-1 text-mit-gray transition hover:bg-gray-50 hover:text-charcoal"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Chat */}
        <div className="flex min-h-[11rem] flex-col rounded-xl border border-gray-100 bg-gray-50/50">
          <div className="max-h-64 flex-1 space-y-3 overflow-y-auto p-4" aria-live="polite">
            {messages.length === 0 ? (
              <div className="flex h-full items-start gap-2 text-sm text-mit-gray">
                <Bot className="mt-0.5 h-4 w-4 shrink-0" />
                <p>
                  Tell me what you want to research next, e.g. “graph neural networks for catalyst discovery” or
                  “causal inference in labour economics”.
                </p>
              </div>
            ) : (
              messages.map((m) => (
                <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <p
                    className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-sm ${
                      m.role === 'user'
                        ? 'rounded-br-md bg-charcoal text-white'
                        : 'rounded-bl-md border border-gray-100 bg-white text-gray-800'
                    }`}
                  >
                    {m.content}
                  </p>
                </div>
              ))
            )}
            <div ref={chatEnd} />
          </div>
          <form onSubmit={send} className="flex items-center gap-2 border-t border-gray-100 bg-white p-2">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              disabled={busy}
              placeholder="Describe your research interests…"
              aria-label="Describe your research interests"
              className="min-w-0 flex-1 rounded-lg bg-transparent px-2 py-2 text-sm placeholder:text-mit-gray focus:outline-none disabled:opacity-60"
            />
            <button
              type="submit"
              disabled={busy || !draft.trim()}
              aria-label="Send"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-cardinal text-white transition hover:bg-cardinal/90 disabled:bg-gray-200 disabled:text-mit-gray"
            >
              <Send className="h-4 w-4" />
            </button>
          </form>
        </div>
      </div>

      <footer className="flex flex-wrap items-center gap-3 border-t border-gray-100 px-5 py-4 sm:px-6">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          {interests.length === 0 ? (
            <span className="text-sm text-mit-gray">Extracted interests will appear here.</span>
          ) : (
            interests.map((i) => (
              <span
                key={i}
                className="flex items-center gap-1 rounded-full bg-cardinal/10 py-1 pl-3 pr-1.5 text-xs font-medium text-cardinal"
              >
                {i}
                {onRemoveInterest && (
                  <button
                    type="button"
                    onClick={() => onRemoveInterest(i)}
                    aria-label={`Remove ${i}`}
                    className="rounded-full p-0.5 hover:bg-cardinal/15"
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </span>
            ))
          )}
        </div>
        <div className="flex gap-2">
          {onReset && hasInput && (
            <button
              type="button"
              onClick={onReset}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-xl border border-gray-200 px-3 py-2 text-sm font-medium text-charcoal transition hover:border-gray-300 disabled:opacity-60"
            >
              <Trash2 className="h-4 w-4" /> Reset
            </button>
          )}
          <button
            type="button"
            onClick={onFindMatches}
            disabled={busy || interests.length === 0}
            className="flex items-center gap-1.5 rounded-xl bg-cardinal px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-cardinal/90 disabled:bg-gray-200 disabled:text-mit-gray disabled:shadow-none"
          >
            {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            Find matches
          </button>
        </div>
      </footer>
    </section>
  )
}

const STATUS_STYLES = {
  idle: ['bg-gray-100 text-gray-600', 'Model not loaded'],
  loading: ['bg-amber-50 text-amber-700', 'Loading model…'],
  ready: ['bg-emerald-50 text-emerald-700', 'Model ready'],
  working: ['bg-cardinal/10 text-cardinal', 'Thinking…'],
  error: ['bg-cardinal/10 text-cardinal', 'Model error'],
  unavailable: ['bg-gray-100 text-gray-600', 'AI coming soon'],
}

function StatusPill({ status }) {
  const [cls, fallback] = STATUS_STYLES[status.state] ?? STATUS_STYLES.idle
  const spinning = status.state === 'loading' || status.state === 'working'
  return (
    <span className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${cls}`} title={status.message}>
      {spinning ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Bot className="h-3.5 w-3.5" />}
      {status.message ?? fallback}
    </span>
  )
}

function DocStatus({ status }) {
  if (status === 'processing') return <LoaderCircle className="h-4 w-4 shrink-0 animate-spin text-cardinal" />
  const label = { queued: 'Queued', done: 'Parsed', error: 'Failed' }[status]
  if (!label) return null
  const cls = status === 'done' ? 'text-emerald-700' : status === 'error' ? 'text-cardinal' : 'text-mit-gray'
  return <span className={`shrink-0 text-xs font-medium ${cls}`}>{label}</span>
}
