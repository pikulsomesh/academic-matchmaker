// Turns laureate_eval.json (written by scripts/laureate_eval.py after every data refresh)
// into the marker the site shows. Kept free of React so it can be tested in Node.

const MARKERS = {
  passing: { tone: 'pass', label: 'Prize-winner test passing' },
  failing: { tone: 'fail', label: 'Prize-winner test failing' },
  error: { tone: 'fail', label: 'Prize-winner test errored' },
  not_run: { tone: 'idle', label: 'Prize-winner test not run yet' },
}

/** -> { tone: 'pass' | 'fail' | 'idle', label, detail } for a laureate_eval.json (or null: not published yet). */
export function laureateMarker(data) {
  const base = MARKERS[data?.status] ?? MARKERS.not_run
  const s = data?.summary ?? {}
  let detail = data?.reason ?? 'No test results have been published yet.'
  if (s.runs_attempted) {
    detail = `${s.runs_passed} of ${s.runs_attempted} matcher runs passed`
    if (s.people_unresolved) detail += `, ${s.people_unresolved} of ${s.people} laureates could not be identified`
  }
  return { ...base, detail }
}

/** One run's rows for display: "passed" | "failed" | "skipped" plus its reason. */
export function runLabel(run) {
  if (!run) return { state: 'skipped', text: 'Not run' }
  if (run.status === 'passed') return { state: 'passed', text: `Top match ${Math.round(run.top_score * 100)}%` }
  if (run.status === 'failed') return { state: 'failed', text: run.error ?? 'Failed' }
  return { state: 'skipped', text: run.reason ?? 'Not run' }
}
