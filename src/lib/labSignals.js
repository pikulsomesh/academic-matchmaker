// Lab signals written by the data pipeline (scripts/README.md, "Lab signals"), full records only:
//   lab_first_authors  distinct first authors on the person's recent last-author papers
//   lab_senior_papers  how many such papers that count is out of
//   recent_funders     up to 3 funders named on their recent papers
//   works_recent_3y / works_prior_3y  papers in the 3 full years before this one vs the 3 before those
// All optional; records built earlier simply show nothing.

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

export function outputTrend(recent, prior) {
  if (recent == null || prior == null) return null
  if (recent >= 3 && recent >= prior * 1.25) return 'rising'
  if (prior >= 3 && recent <= prior * 0.6) return 'declining'
  return 'steady'
}

export function labSignals(f) {
  const firstAuthors = num(f?.lab_first_authors)
  const papers = num(f?.lab_senior_papers)
  const funders = Array.isArray(f?.recent_funders) ? f.recent_funders.filter(Boolean).slice(0, 3) : []
  const recent = num(f?.works_recent_3y)
  const prior = num(f?.works_prior_3y)
  return {
    firstAuthors: firstAuthors != null && papers ? firstAuthors : null,
    papers: firstAuthors != null && papers ? papers : null,
    funders,
    recent,
    prior,
    trend: outputTrend(recent, prior),
    any: (firstAuthors != null && papers > 0) || funders.length > 0 || (recent != null && prior != null && recent + prior > 0),
  }
}
