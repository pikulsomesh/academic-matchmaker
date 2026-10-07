import { useEffect, useMemo, useState } from 'react'
import { Document } from 'flexsearch'

const DATA_URL = `${import.meta.env.BASE_URL}data/`

export const EMPTY_FILTERS = { country: '', institution: '', domains: [] }

export const SORTS = {
  relevance: 'Best match',
  citations: 'Most cited',
  rank: 'University rank',
  name: 'Name (A–Z)',
}

// Every domain a faculty member works in: the primary one plus any weighted ones.
export function facultyDomains(f) {
  const set = new Set(Object.keys(f.domain_weights ?? {}))
  if (f.primary_domain) set.add(f.primary_domain)
  return set
}

function searchableText(f) {
  return [
    f.institution?.name,
    f.primary_domain,
    ...Object.keys(f.domain_weights ?? {}),
    ...(f.recent_publications ?? []).map((p) => p.title),
  ]
    .filter(Boolean)
    .join(' ')
}

function buildIndex(faculty) {
  const index = new Document({
    tokenize: 'forward',
    document: { id: 'id', index: ['name', 'title', 'text'] },
  })
  for (const f of faculty) {
    index.add({ id: f.id, name: f.name ?? '', title: f.title ?? '', text: searchableText(f) })
  }
  return index
}

async function fetchJson(name, fallback) {
  try {
    const res = await fetch(`${DATA_URL}${name}`)
    if (!res.ok) throw new Error(`${name}: ${res.status}`)
    return await res.json()
  } catch {
    return fallback
  }
}

/**
 * Loads the faculty index, keeps a FlexSearch full-text index over it, and
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
    Promise.all([
      fetchJson('faculty_index.json', null),
      fetchJson('universities.json', []),
      fetchJson('domains.json', []),
    ]).then(([fac, unis, doms]) => {
      if (cancelled) return
      if (!Array.isArray(fac)) setError('Could not load the faculty index.')
      setFaculty(Array.isArray(fac) ? fac : [])
      setUniversities(Array.isArray(unis) ? unis : [])
      setAllDomains(Array.isArray(doms) ? doms : [])
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const index = useMemo(() => buildIndex(faculty), [faculty])

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
      hits = new Map()
      index.search(q, { merge: true, limit: 5000 }).forEach((r, i) => hits.set(r.id, i))
    }

    const rows = faculty.filter((f) => {
      if (hits && !hits.has(f.id)) return false
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
        if (hits) return hits.get(a.id) - hits.get(b.id)
        return byCitations(a, b)
      },
      citations: byCitations,
      rank: (a, b) => (a.institution?.rank ?? 999) - (b.institution?.rank ?? 999) || byCitations(a, b),
      name: (a, b) => (a.name ?? '').localeCompare(b.name ?? ''),
    }
    return rows.sort(comparators[sort] ?? comparators.relevance)
  }, [faculty, index, query, filters, sort, matchScores])

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
  }
}
