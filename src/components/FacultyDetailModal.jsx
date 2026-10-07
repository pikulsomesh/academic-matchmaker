import { useEffect, useRef, useState } from 'react'
import { Award, BookOpen, LoaderCircle, MapPin, Quote, Sparkles } from 'lucide-react'
import CopyLinkButton from './CopyLinkButton.jsx'
import Modal from './Modal.jsx'
import { ContactLinks, ShortlistToggle } from './FacultyCard.jsx'
import { countryName, sortedWeights } from '../lib/format.js'
import { useFullRecord } from '../data/facultyStore.js'
import { RoleSection } from './RoleSignals.jsx'
import { POSITION_LABEL } from '../lib/roles.js'

// What in their work is closest to the visitor's profile; computed in the browser (useLocalAI.explain).
function WhyMatch({ record, explain }) {
  const [state, setState] = useState({ loading: true, why: null })
  // The record object changes identity on every render; only a different person or newly loaded papers matter.
  const recordRef = useRef(record)
  recordRef.current = record
  const recordKey = `${record.id}:${record.recent_publications?.length ?? 0}`
  useEffect(() => {
    let live = true
    setState({ loading: true, why: null })
    explain(recordRef.current)
      .then((why) => live && setState({ loading: false, why }))
      .catch(() => live && setState({ loading: false, why: null }))
    return () => {
      live = false
    }
  }, [recordKey, explain])

  if (state.loading) {
    return (
      <p className="flex items-center gap-2 p-6 text-sm text-mit-gray sm:px-8">
        <LoaderCircle className="h-4 w-4 animate-spin" /> Working out why this is a match…
      </p>
    )
  }
  const { why } = state
  if (!why || (!why.papers.length && !why.areas.length)) return null
  return (
    <section className="space-y-4 bg-cardinal/5 p-6 sm:px-8">
      <h3 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-cardinal">
        <Sparkles className="h-4 w-4" /> Why this match
      </h3>
      {why.shared.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-sm font-medium text-charcoal">Your interests that appear in their work</p>
          <div className="flex flex-wrap gap-1.5">
            {why.shared.map((t) => (
              <span key={t} className="rounded-full bg-white px-2.5 py-0.5 text-xs font-medium text-cardinal">
                {t}
              </span>
            ))}
          </div>
        </div>
      )}
      {why.areas.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-sm font-medium text-charcoal">Closest research areas</p>
          <div className="flex flex-wrap gap-1.5">
            {why.areas.map((a) => (
              <span key={a.name} className="rounded-full bg-white px-2.5 py-0.5 text-xs font-medium text-gray-700">
                {a.name}
              </span>
            ))}
          </div>
        </div>
      )}
      {why.papers.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-sm font-medium text-charcoal">Recent papers closest to your profile</p>
          <ul className="space-y-1.5 text-sm text-gray-700">
            {why.papers.map((p) => (
              <li key={p.title}>
                {p.title}
                {p.year && <span className="text-mit-gray"> · {p.year}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="text-xs text-mit-gray">Ranked by similarity to your profile, computed in your browser.</p>
    </section>
  )
}

// `row` is a catalog row; the full record (publications, weights, contact
// details) loads from that university's file while the modal is open.
// `explain` (optional) powers the "Why this match" section for matched researchers.
export default function FacultyDetailModal({ faculty: row, onClose, matchScore, saved = false, onToggleSave, explain }) {
  const { faculty, loading } = useFullRecord(row)
  const open = Boolean(row)
  const inst = faculty?.institution ?? {}
  const weights = sortedWeights(faculty?.domain_weights)
  const pubs = [...(faculty?.recent_publications ?? [])].sort((a, b) => (b.year ?? 0) - (a.year ?? 0))

  return (
    <Modal open={open} onClose={onClose} labelledBy="faculty-title">
      {faculty && (
        <div className="divide-y divide-gray-100">
          <div className="space-y-4 p-6 pr-14 sm:p-8 sm:pr-16">
            <div>
              {faculty.primary_domain && (
                <p className="text-xs font-semibold uppercase tracking-wide text-cardinal">{faculty.primary_domain}</p>
              )}
              <div className="mt-1 flex items-center gap-2">
                <h2 id="faculty-title" className="text-2xl font-semibold tracking-tight text-charcoal">
                  {faculty.name}
                </h2>
                {onToggleSave && <ShortlistToggle saved={saved} onToggle={() => onToggleSave(row)} name={faculty.name} />}
              </div>
              {faculty.title && <p className="mt-1 text-gray-600">{faculty.title}</p>}
            </div>
            <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-mit-gray">
              <span className="flex items-center gap-1.5">
                <MapPin className="h-4 w-4" />
                {inst.name}
                {inst.country_code && ` · ${countryName(inst.country_code)}`}
              </span>
              {inst.rank != null && (
                <span className="flex items-center gap-1.5">
                  <Award className="h-4 w-4" /> Ranked #{inst.rank}
                </span>
              )}
              <span className="flex items-center gap-1.5">
                <Quote className="h-4 w-4" /> {(faculty.citation_count ?? 0).toLocaleString()} citations
              </span>
              {matchScore != null && (
                <span className="font-semibold text-cardinal">{Math.round(matchScore * 100)}% match</span>
              )}
              <CopyLinkButton />
            </div>
          </div>

          <section className="space-y-3 bg-gray-50/60 p-6 sm:px-8">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-mit-gray">Verified contact</h3>
            <ContactLinks faculty={faculty} size="lg" />
            {faculty.profile_url && (
              <p className="break-all text-xs text-mit-gray">{faculty.profile_url}</p>
            )}
          </section>

          {matchScore != null && explain && !loading && <WhyMatch record={faculty} explain={explain} />}

          <RoleSection faculty={faculty} />

          {loading && (
            <p className="flex items-center gap-2 p-6 text-sm text-mit-gray sm:px-8">
              <LoaderCircle className="h-4 w-4 animate-spin" /> Loading research areas and publications…
            </p>
          )}

          {weights.length > 0 && (
            <section className="space-y-3 p-6 sm:px-8">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-mit-gray">Research areas</h3>
              <ul className="space-y-2.5">
                {weights.map(([name, w]) => (
                  <li key={name}>
                    <div className="flex justify-between text-sm">
                      <span className="font-medium text-charcoal">{name}</span>
                      <span className="text-mit-gray">{Math.round(w * 100)}%</span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-gray-100">
                      <div className="h-full rounded-full bg-cardinal" style={{ width: `${Math.min(100, w * 100)}%` }} />
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {pubs.length > 0 && (
            <section className="space-y-3 p-6 sm:px-8">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-mit-gray">Recent publications</h3>
              <ul className="space-y-3">
                {pubs.map((p, i) => (
                  <li key={`${p.title}-${i}`} className="flex gap-3 text-sm">
                    <BookOpen className="mt-0.5 h-4 w-4 shrink-0 text-mit-gray" />
                    <span>
                      <span className="text-charcoal">{p.title}</span>
                      {p.year && <span className="text-mit-gray"> · {p.year}</span>}
                      {POSITION_LABEL[p.position] && (
                        <span className="ml-2 rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-700">
                          {POSITION_LABEL[p.position]}
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </Modal>
  )
}
