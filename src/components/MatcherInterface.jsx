import { useState } from 'react'
import { Loader2, Send, Upload, X } from 'lucide-react'

// Minimal working matcher wired to useLocalAI. The UI thread owns the final
// layout and styling; the `ai` prop is the whole contract (see useLocalAI.js).
export default function MatcherInterface({ ai }) {
  const [draft, setDraft] = useState('')
  const [dragging, setDragging] = useState(false)

  const handleFiles = async (files) => {
    for (const file of files) await ai.addDocument(file)
  }

  const submit = (e) => {
    e.preventDefault()
    ai.sendMessage(draft)
    setDraft('')
  }

  const loading = Object.entries(ai.progress).filter(([, p]) => p != null && p < 100)

  return (
    <div className="space-y-4 rounded-2xl border border-gray-100 p-6 shadow-sm">
      <label
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          handleFiles([...e.dataTransfer.files])
        }}
        className={`flex cursor-pointer flex-col items-center gap-2 rounded-xl border border-dashed p-6 text-center text-sm text-mit-gray ${
          dragging ? 'border-cardinal bg-red-50' : 'border-gray-200'
        }`}
      >
        <Upload className="h-5 w-5" />
        Drop a resume PDF, Google Scholar screenshot or saved LinkedIn page
        <input
          type="file"
          multiple
          accept=".pdf,image/*,.html,.htm,.txt,.md"
          className="hidden"
          onChange={(e) => {
            handleFiles([...e.target.files])
            e.target.value = ''
          }}
        />
      </label>

      {ai.messages.length > 0 && (
        <ul className="space-y-1 text-sm">
          {ai.messages.map((m, i) => (
            <li key={i} className={m.role === 'user' ? 'text-charcoal' : 'text-mit-gray'}>
              {m.content}
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={submit} className="flex gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Add interests in your own words, e.g. “battery materials and graph neural networks”"
          className="flex-1 rounded-xl border border-gray-200 px-3 py-2 text-sm focus:border-cardinal focus:outline-none"
        />
        <button type="submit" disabled={!draft.trim()} className="rounded-xl bg-cardinal px-3 text-white disabled:opacity-50">
          <Send className="h-4 w-4" />
        </button>
      </form>

      {ai.profile.interests.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {ai.profile.interests.map((topic) => (
            <span key={topic} className="flex items-center gap-1 rounded-full border border-gray-200 px-3 py-1 text-xs text-charcoal">
              {topic}
              <button onClick={() => ai.removeInterest(topic)} aria-label={`Remove ${topic}`}>
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      {(ai.busy || loading.length > 0) && (
        <p className="flex items-center gap-2 text-xs text-mit-gray">
          <Loader2 className="h-3 w-3 animate-spin" />
          {loading.length > 0
            ? `Downloading ${loading.map(([model, p]) => `${model} model ${p}%`).join(', ')}`
            : ai.busy}
        </p>
      )}
      {ai.error && <p className="text-xs text-cardinal">{ai.error}</p>}
    </div>
  )
}
