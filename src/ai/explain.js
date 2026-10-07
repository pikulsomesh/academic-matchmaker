// "Why this match": what in a researcher's work is closest to the visitor's
// profile. The profile text and the researcher's research areas and paper titles
// are embedded together by the worker; this ranks the results. Kept free of
// model code so it can be tested in Node.

import { cosineSimilarity } from './vectors.js'

const TOP_AREAS = 3
const TOP_PAPERS = 3

/**
 * `matrix` is the embedding of [profile, ...areas, ...papers], row-major.
 * -> { areas: [{ name, score }], papers: [{ title, year, score }] } best first.
 */
export function rankEvidence({ dim, matrix, areas, papers }) {
  const row = (i) => matrix.subarray(i * dim, (i + 1) * dim)
  const profile = row(0)
  const score = (i) => cosineSimilarity(profile, row(i))
  return {
    areas: areas
      .map((name, i) => ({ name, score: score(1 + i) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, TOP_AREAS),
    papers: papers
      .map((p, i) => ({ title: p.title, year: p.year ?? null, score: score(1 + areas.length + i) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, TOP_PAPERS),
  }
}

const words = (text) => text.toLowerCase().match(/[a-z0-9][a-z0-9-]+/g) ?? []
const STOP = new Set(['and', 'the', 'for', 'with', 'of', 'in', 'on', 'to', 'a', 'an'])

/** The visitor's own interests that appear (every significant word) in the researcher's areas or paper titles. */
export function sharedInterests(interests, texts) {
  const haystack = new Set(texts.flatMap((t) => words(t)))
  return interests.filter((interest) => {
    const needed = words(interest).filter((w) => !STOP.has(w))
    return needed.length > 0 && needed.every((w) => haystack.has(w))
  })
}
