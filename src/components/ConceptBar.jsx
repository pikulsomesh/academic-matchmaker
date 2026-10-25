import { useState } from 'react'
import { Plus, Tags, X } from 'lucide-react'

/**
 * Concept chips over the results: each chip is one research concept matched against the
 * researchers' OpenAlex tags, synonyms included (lib/concepts.js). Chips are ANDed unless
 * the visitor switches to "any".
 *
 * suggestions: tags read from the visitor's profile ([{ tag }]), offered as one-click chips.
 */
export default function ConceptBar({
  concepts,
  addConcepts,
  addConcept,
  removeConcept,
  conceptMode,
  setConceptMode,
  conceptDetails = [],
  conceptNotice,
  resultCount,
  suggestions = [],
}) {
  const [draft, setDraft] = useState('')
  const submit = (e) => {
    e.preventDefault()
    if (addConcepts(draft)) setDraft('')
  }
  const detailOf = (c) => conceptDetails.find((d) => d.concept === c)
  const taken = new Set(concepts.map((c) => c.toLowerCase()))
  const offered = suggestions.filter((s) => !taken.has(s.tag.toLowerCase())).slice(0, 8)

  return (
    <div className="space-y-2.5 rounded-xl border border-gray-200 px-3.5 py-3 shadow-sm">
      <form onSubmit={submit} className="flex items-center gap-2">
        <Tags className="h-4 w-4 shrink-0 text-mit-gray" />
        <label className="min-w-0 flex-1">
          <span className="sr-only">Add research concepts</span>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Add concepts, e.g. gastrointestinal + peptide"
            className="w-full bg-transparent py-1 text-sm text-charcoal placeholder:text-mit-gray focus:outline-none"
          />
        </label>
        <button
          type="submit"
          disabled={!draft.trim()}
          className="flex items-center gap-1 rounded-lg bg-charcoal px-2.5 py-1.5 text-xs font-medium text-white disabled:opacity-40"
        >
          <Plus className="h-3.5 w-3.5" /> Add
        </button>
      </form>

      {conceptNotice && <p className="text-xs text-cardinal">{conceptNotice}</p>}

      {concepts.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {concepts.map((c, i) => {
            const detail = detailOf(c)
            const reach = detail?.examples?.length ? `Matches tags such as: ${detail.examples.join('; ')}` : 'Matches research areas and titles'
            return (
              <span key={c} className="flex items-center gap-1.5">
                {i > 0 && <span className="text-xs font-semibold uppercase text-mit-gray">{conceptMode === 'any' ? 'or' : 'and'}</span>}
                <span
                  title={reach}
                  className="flex items-center gap-1 rounded-full bg-cardinal/10 py-0.5 pl-2.5 pr-1 text-xs font-medium text-cardinal"
                >
                  {c}
                  {detail && <span className="font-normal text-cardinal/70">· {detail.tagCount} tags</span>}
                  <button
                    type="button"
                    onClick={() => removeConcept(c)}
                    aria-label={`Remove ${c}`}
                    className="rounded-full p-0.5 hover:bg-cardinal/15"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              </span>
            )
          })}
          {concepts.length > 1 && (
            <span className="ml-auto flex overflow-hidden rounded-lg border border-gray-200 text-xs">
              {[
                ['all', 'Match all'],
                ['any', 'Match any'],
              ].map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setConceptMode(value)}
                  aria-pressed={conceptMode === value}
                  className={`px-2 py-1 ${conceptMode === value ? 'bg-charcoal text-white' : 'text-charcoal hover:bg-gray-50'}`}
                >
                  {label}
                </button>
              ))}
            </span>
          )}
        </div>
      )}

      {concepts.length > 0 && resultCount === 0 && conceptMode === 'all' && concepts.length > 1 && (
        <p className="text-xs text-mit-gray">
          Nobody matches every concept here.{' '}
          <button type="button" onClick={() => setConceptMode('any')} className="font-medium text-cardinal hover:underline">
            Show people who match any
          </button>
        </p>
      )}

      {offered.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-mit-gray">From your profile:</span>
          {offered.map((s) => (
            <button
              key={s.tag}
              type="button"
              onClick={() => addConcept(s.tag)}
              className="flex items-center gap-1 rounded-full border border-dashed border-gray-300 px-2 py-0.5 text-xs text-charcoal hover:border-cardinal/50 hover:text-cardinal"
            >
              <Plus className="h-3 w-3" /> {s.tag}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
