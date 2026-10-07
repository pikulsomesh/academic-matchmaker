import { useEffect, useMemo, useState } from 'react'
import { Index } from 'flexsearch'
import { loadCatalog } from '../data/facultyStore.js'

export const EMPTY_FILTERS = { country: '', institution: '', domains: [] }

export const SORTS = {
  relevance: 'Best match',
  citations: 'Most cited',
  rank: 'University rank',
  name: 'Name (A–Z)',
}

// Every domain a faculty member works in: the primary one plus any weighted ones.
export function facultyDomains(f) {
  return new Set(f.domains ?? [])
}

// Text indexed per person. Publication titles are only there when full
// records are in the catalog (the single-file faculty_index.json).
function personText(f) {
  return [f.name, f.title, ...(f.recent_publications ?? []).map((p) => p.title)].filter(Boolean).join(' ')
}

const INDEX_CHUNK = 2000

// Builds the FlexSearch index a chunk at a time so ~100k rows don't freeze the
// page; resolves to null if cancelled. Institution names and domains repeat
// across thousands of rows, so they're matched separately (see search()).
async function buildIndex(faculty, isCancelled) {
  const index = new Index({ tokenize: 'forward' })
  for (let start = 0; start < faculty.length; start += INDEX_CHUNK) {
    if (isCancelled()) return null
    const end = Math.min(start + INDEX_CHUNK, faculty.length)
    for (let i = start; i < end; i++) index.add(i, personText(faculty[i]))
    await new Promise((resolve) => setTimeout(resolve))
  }
  return index
}

// Row positions matching `q`, best first: FlexSearch hits on name, title and
// publications (or a plain scan while the index is still building), then
// everyone at a matching institution or in a matching domain.
function search(q, faculty, index) {
  const needle = q.toLowerCase()
  const order = new Map()
  if (index) {
    index.search(q, { limit: Math.max(faculty.length, 1) }).forEach((i) => order.set(i, order.size))
  } else {
    faculty.forEach((f, i) => personText(f).toLowerCase().includes(needle) && order.set(i, order.size))
  }
  const matched = new Map()
  const matches = (text) => {
    if (!text) return false
    if (!matched.has(text)) matched.set(text, text.toLowerCase().includes(needle))
    return matched.get(text)
  }
  faculty.forEach((f, i) => {
    if (!order.has(i) && (matches(f.institution?.name) || (f.domains ?? []).some(matches))) order.set(i, order.size)
  })
  return order
}

/**
 * Loads the faculty catalog (see data/facultyStore.js), keeps a FlexSearch full-text index over it, and
 * applies keyword search, cascading filters and sorting.
 *
 * `setMatchScores` takes an optional `{ [facultyId]: score }` map (0–1) from
 * the local AI matcher. While set, only scored faculty are shown and the
 * "relevance" sort orders by that score.
 */
export default function useFacultySearch() {
  const [faculty, setFaculty] = useState([])
  const [universities, setUniversities] = useState([])
  const [allDomains, setAllDomains] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const [query, setQuery] = useState('')
  const [filters, setFilters] = useState(EMPTY_FILTERS)
  const [sort, setSort] = useState('relevance')
  const [matchScores, setMatchScores] = useState(null)

  useEffect(() => {
    let cancelled = false
    loadCatalog()
      .then(({ rows, universities: unis, domains }) => {
        if (cancelled) return
        setFaculty(rows)
        setUniversities(unis)
        setAllDomains(domains)
      })
      .catch(() => !cancelled && setError('Could not load the faculty index.'))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [])

  const [index, setIndex] = useState(null)
  useEffect(() => {
    let cancelled = false
    setIndex(null)
    buildIndex(faculty, () => cancelled).then((built) => built && setIndex(built))
    return () => {
      cancelled = true
    }
  }, [faculty])

  // Facet options, derived from the data so no filter ever leads to zero rows by itself.
  const options = useMemo(() => {
    const rankByName = new Map(universities.map((u) => [u.name, u.rank]))
    const countries = new Map()
    const institutions = new Map()
    const domains = new Map(allDomains.map((d) => [d, 0]))

    for (const f of faculty) {
      const inst = f.institution ?? {}
      if (inst.country_code) countries.set(inst.country_code, (countries.get(inst.country_code) ?? 0) + 1)
      if (inst.name) {
        const entry = institutions.get(inst.name) ?? {
          id: inst.id,
          name: inst.name,
          country_code: inst.country_code,
          rank: inst.rank ?? rankByName.get(inst.name),
          count: 0,
        }
        entry.count += 1
        institutions.set(inst.name, entry)
      }
      for (const d of facultyDomains(f)) domains.set(d, (domains.get(d) ?? 0) + 1)
    }

    const institutionsAll = [...institutions.values()].sort(
      (a, b) => (a.rank ?? 999) - (b.rank ?? 999) || a.name.localeCompare(b.name),
    )
    return {
      countries: [...countries].map(([code, count]) => ({ code, count })).sort((a, b) => a.code.localeCompare(b.code)),
      // Cascading: the institution list narrows to the selected country.
      institutions: institutionsAll.filter((i) => !filters.country || i.country_code === filters.country),
      institutionsAll,
      domains: [...domains].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name)),
    }
  }, [faculty, universities, allDomains, filters.country])

  const results = useMemo(() => {
    const q = query.trim()
    let hits = null
    if (q) {
      // FlexSearch returns ids per field; merge keeps the best-ranked field order.
      hits = search(q, faculty, index)
    }

    const position = hits ? new Map(faculty.map((f, i) => [f, i])) : null
    const rows = faculty.filter((f, i) => {
      if (hits && !hits.has(i)) return false
      if (matchScores && !(f.id in matchScores)) return false
      if (filters.country && f.institution?.country_code !== filters.country) return false
      if (filters.institution && f.institution?.name !== filters.institution) return false
      if (filters.domains.length) {
        const ds = facultyDomains(f)
        if (!filters.domains.some((d) => ds.has(d))) return false
      }
      return true
    })

    const byCitations = (a, b) => (b.citation_count ?? 0) - (a.citation_count ?? 0)
    const comparators = {
      relevance: (a, b) => {
        if (matchScores) return (matchScores[b.id] ?? 0) - (matchScores[a.id] ?? 0)
        if (hits) return hits.get(position.get(a)) - hits.get(position.get(b))
        return byCitations(a, b)
      },
      citations: byCitations,
      rank: (a, b) => (a.institution?.rank ?? 999) - (b.institution?.rank ?? 999) || byCitations(a, b),
      name: (a, b) => (a.name ?? '').localeCompare(b.name ?? ''),
    }
    return rows.sort(comparators[sort] ?? comparators.relevance)
  }, [faculty, index, query, filters, sort, matchScores])

  // Universities the country / institution filters leave in view (null = all),
  // so the matcher only downloads the embedding shards it needs.
  const scopeInstitutionIds = useMemo(() => {
    if (!filters.country && !filters.institution) return null
    return options.institutionsAll
      .filter((i) => (!filters.institution || i.name === filters.institution) && (!filters.country || i.country_code === filters.country))
      .map((i) => i.id)
      .filter(Boolean)
  }, [options.institutionsAll, filters.country, filters.institution])

  const activeFilterCount =
    (filters.country ? 1 : 0) + (filters.institution ? 1 : 0) + filters.domains.length

  return {
    faculty,
    results,
    loading,
    error,
    options,
    query,
    setQuery,
    filters,
    setFilters,
    resetFilters: () => setFilters(EMPTY_FILTERS),
    activeFilterCount,
    sort,
    setSort,
    matchScores,
    setMatchScores,
    scopeInstitutionIds,
  }
}
