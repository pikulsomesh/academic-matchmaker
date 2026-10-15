import { useEffect, useState } from 'react'
import { ExternalLink } from 'lucide-react'
import LaureateMarker from './LaureateMarker.jsx'
import { loadLaureateEval } from '../data/facultyStore.js'
import { laureateMarker, runLabel } from '../lib/laureate.js'

const PATHS = [
  { key: 'openalex', label: 'From ORCID / OpenAlex' },
  { key: 'resume', label: 'From CV PDF' },
]

const STATE_CLASSES = {
  passed: 'text-emerald-700',
  failed: 'text-cardinal',
  skipped: 'text-mit-gray',
}

function Connections({ connections }) {
  if (!connections) return null
  const { shared_interests: shared = [], areas = [], papers = [] } = connections
  if (!shared.length && !areas.length && !papers.length) return null
  return (
    <div className="mt-1 space-y-0.5 text-xs text-gray-600">
      {shared.length > 0 && <p>Shared topics: {shared.join(', ')}</p>}
      {areas.length > 0 && <p>Closest areas: {areas.map((a) => a.name).join(', ')}</p>}
      {papers.length > 0 && <p>Closest paper: {papers[0].title}{papers[0].year ? ` (${papers[0].year})` : ''}</p>}
    </div>
  )
}

function RunPanel({ label, run }) {
  const info = runLabel(run)
  return (
    <div className="rounded-xl border border-gray-100 p-3">
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className="font-medium text-charcoal">{label}</span>
        <span className={`text-xs font-medium ${STATE_CLASSES[info.state]}`}>{info.text}</span>
      </div>
      {run?.status === 'passed' || run?.status === 'failed' ? (
        <>
          {run.profile?.interests?.length > 0 && (
            <p className="mt-1 text-xs text-gray-600">Profile topics: {run.profile.interests.join(', ')}</p>
          )}
          {run.self_rank ? (
            <p className="mt-1 text-xs text-gray-600">Their own record ranks #{run.self_rank} among their matches.</p>
          ) : (
            <p className="mt-1 text-xs text-mit-gray">Their own record is not in the top matches (or not in the data).</p>
          )}
          <ol className="mt-2 space-y-2">
            {(run.matches ?? []).slice(0, 5).map((m, i) => (
              <li key={m.id} className="text-sm">
                <span className="text-mit-gray">{i + 1}.</span> <span className="font-medium text-charcoal">{m.name ?? m.id}</span>
                {m.is_self && <span className="ml-1 rounded bg-amber-100 px-1 text-xs text-amber-800">themselves</span>}
                <span className="text-xs text-mit-gray">
                  {' '}
                  · {m.institution ?? ''} · {Math.round(m.score * 100)}%
                </span>
                <Connections connections={m.connections} />
              </li>
            ))}
          </ol>
        </>
      ) : null}
    </div>
  )
}

function Laureate({ entry }) {
  const { identity } = entry
  return (
    <article className="rounded-2xl border border-gray-200 p-4 shadow-sm">
      <h3 className="text-lg font-semibold text-charcoal">{entry.name}</h3>
      <p className="text-sm text-gray-600">
        {entry.prize} {entry.year} · {entry.institution}
      </p>
      <p className="mt-1 text-xs text-mit-gray">{entry.citation}</p>
      <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        {identity.orcid ? (
          <a href={`https://orcid.org/${identity.orcid}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-cardinal hover:underline">
            ORCID {identity.orcid} <ExternalLink className="h-3 w-3" />
          </a>
        ) : (
          <span className="text-mit-gray">No ORCID found</span>
        )}
        {identity.openalex_id ? (
          <a href={`https://openalex.org/${identity.openalex_id}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-cardinal hover:underline">
            OpenAlex {identity.openalex_id} <ExternalLink className="h-3 w-3" />
          </a>
        ) : (
          <span className="text-mit-gray">{identity.note ?? 'No OpenAlex profile found'}</span>
        )}
        {entry.cv_pdf && (
          <a href={`https://github.com/pikulsomesh/academic-matchmaker/blob/main/${entry.cv_pdf}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-cardinal hover:underline">
            CV PDF <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </p>
      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        {PATHS.map((p) => (
          <RunPanel key={p.key} label={p.label} run={entry.runs?.[p.key]} />
        ))}
      </div>
    </article>
  )
}

export default function DemoPage() {
  const [data, setData] = useState(undefined)
  useEffect(() => {
    loadLaureateEval().then(setData)
  }, [])
  const entries = data?.entries ?? []
  const marker = laureateMarker(data)

  return (
    <div className="space-y-6">
      <div className="max-w-3xl">
        <h1 className="text-3xl font-semibold tracking-tight text-charcoal sm:text-4xl">Does the matcher work on people we know?</h1>
        <p className="mt-3 text-lg leading-relaxed text-gray-600">
          A fixed test set: the 2026 Fields Medal and Nobel Prize winners. Each one is run through the same matching steps as the home page, once from their
          ORCID / OpenAlex profile and once from a CV PDF where we have one, and the closest researchers and the connections behind each match are shown below. The
          test re-runs after every data refresh.
        </p>
      </div>

      {data === undefined ? (
        <div className="h-24 animate-pulse rounded-2xl border border-gray-100 bg-gray-50" />
      ) : (
        <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm">
          <LaureateMarker data={data} />
          <span className="text-gray-600">{marker.detail}</span>
          {data?.generated_at && <span className="text-mit-gray">Last run {new Date(data.generated_at).toLocaleDateString(undefined, { dateStyle: 'medium' })}</span>}
          {data?.run_url && (
            <a href={data.run_url} target="_blank" rel="noreferrer" className="font-medium text-cardinal hover:underline">
              Run log
            </a>
          )}
        </div>
      )}

      {data && (
        <details className="rounded-xl border border-gray-100 px-4 py-3 text-sm text-gray-600">
          <summary className="cursor-pointer font-medium text-charcoal">How the test decides</summary>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>A run passes when a profile is built and the best match scores at least 30%. The marker passes when at least 80% of attempted runs pass.</li>
            <li>Whether a laureate finds their own record among their matches is shown but not scored: the data covers only faculty at the top 100 universities.</li>
            <li>The CV path uses the site's no-language-model profile (embedding only). {data.encoder}.</li>
            <li>Sources: ORCID and OpenAlex public records and public university pages.</li>
          </ul>
        </details>
      )}

      {data && entries.length === 0 && (
        <p className="rounded-2xl border border-dashed border-gray-200 px-6 py-12 text-center text-sm text-mit-gray">
          {data.reason ?? 'No results yet. They appear after the first data refresh that includes the test.'}
        </p>
      )}
      {data === null && (
        <p className="rounded-2xl border border-dashed border-gray-200 px-6 py-12 text-center text-sm text-mit-gray">
          The prize-winner test has not run yet. Its results appear here after the next data refresh.
        </p>
      )}
      <div className="grid gap-4">
        {entries.map((entry) => (
          <Laureate key={entry.id} entry={entry} />
        ))}
      </div>
    </div>
  )
}
