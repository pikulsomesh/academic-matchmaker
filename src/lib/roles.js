// Role signals from authorship order, written by the data pipeline
// (scripts/README.md, "Role signals"). All are optional: records built before
// the pipeline added them show no badge or role line, and the "Likely PIs
// first" sort falls back to citations.
//
// In most lab sciences the first author did the work and the last author
// leads (and usually funds) the group. Fields that list authors
// alphabetically, such as economics and mathematics, break that convention.

// seniority_score is 0-100; at or above this the card shows "Likely PI".
export const PI_THRESHOLD = 60

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

export const piScoreOf = (f) => num(f?.seniority_score)

export function roleSignals(f) {
  const positions = (f?.recent_publications ?? []).map((p) => p.position).filter(Boolean)
  const firstAuthor = num(f?.first_author_recent) ?? (positions.length ? positions.filter((p) => p === 'first').length : null)
  const lastAuthor = num(f?.last_author_recent) ?? (positions.length ? positions.filter((p) => p === 'last').length : null)
  const piScore = piScoreOf(f)
  return {
    piScore,
    firstAuthor,
    lastAuthor,
    // Of their latest (up to 5) papers, how many have a known author position.
    knownPapers: num(f?.recent_works) || positions.length || null,
    // The pipeline writes 0/0 when positions are unknown, so only non-zero counts say anything.
    hasAuthorship: (firstAuthor ?? 0) + (lastAuthor ?? 0) > 0,
    likelyPI: piScore != null && piScore >= PI_THRESHOLD,
  }
}

export const POSITION_LABEL = { first: 'First author', last: 'Senior author' }
