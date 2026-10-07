import { useEffect, useMemo, useState } from 'react'
import { ArrowUpDown, Info, Search, SlidersHorizontal, Sparkles, X } from 'lucide-react'
import Navbar from './components/Navbar.jsx'
import FilterSidebar from './components/FilterSidebar.jsx'
import MatcherInterface from './components/MatcherInterface.jsx'
import FacultyCard from './components/FacultyCard.jsx'
import FacultyDetailModal from './components/FacultyDetailModal.jsx'
import AboutModal from './components/AboutModal.jsx'
import CopyLinkButton from './components/CopyLinkButton.jsx'
import ShortlistModal from './components/ShortlistModal.jsx'
import { loadPipelineStatus } from './data/facultyStore.js'
import useFacultySearch, { SORTS } from './hooks/useFacultySearch.js'
import useLocalAI from './hooks/useLocalAI.js'
import useMatcherBridge from './hooks/useMatcherBridge.js'
import useShortlist from './hooks/useShortlist.js'
import { buildHash, parseHash } from './lib/urlState.js'

const PAGE_SIZE = 24

// Explains what a large build's results cover (null when they cover everyone).
function coverageMessage(coverage, filtered, matchScope) {
  if (coverage.loadingUniversities > 0) return 'Loading every researcher at the selected universities…'
  if (matchScope) {
    return `AI matches come from the top ${matchScope.universities} of ${matchScope.totalUniversities} universities. Pick a country or university to match everyone there.`
  }
  if (!coverage.partial) return null
  if (!filtered) {
    return `Searching the ${coverage.loadedRows.toLocaleString()} most active of ${coverage.totalRows.toLocaleString()} researchers. Pick a country or university to search everyone there.`
  }
  if (coverage.skippedUniversities > 0) {
    return `This country has too many researchers to load at once, so ${coverage.skippedUniversities} lower-ranked universities show only their most active people. Pick a university to search everyone there.`
  }
  return null
}

export default function App() {
  const search = useFacultySearch()
  const { results, loading, error, query, setQuery, sort, setSort, activeFilterCount, matchScores } = search
  const ai = useLocalAI(search.faculty, { institutionIds: search.scopeInstitutionIds })
  const matcher = useMatcherBridge(ai)
  const { setMatchScores, loadUniversities, coverage } = search
  useEffect(() => setMatchScores(matcher.matchScores), [matcher.matchScores, setMatchScores])
  // Large builds: bring in the rows of AI matches outside the catalog.
  useEffect(() => loadUniversities(ai.missingInstitutionIds), [ai.missingInstitutionIds, loadUniversities])
  const filtered = Boolean(search.filters.country || search.filters.institution)
  const coverageNote = coverageMessage(coverage, filtered, matchScores ? ai.matchScope : null)

  const shortlist = useShortlist()
  const [dataStatus, setDataStatus] = useState(null)
  useEffect(() => {
    loadPipelineStatus().then(setDataStatus)
  }, [])
  const [selected, setSelected] = useState(null)
  const [aboutOpen, setAboutOpen] = useState(false)
  const [shortlistOpen, setShortlistOpen] = useState(false)

  // A shared link names the open researcher (#r=<id>); open them once the catalog is in.
  // People outside the catalog on large builds open only if they're on this visitor's shortlist.
  const [pendingResearcher, setPendingResearcher] = useState(() => parseHash(window.location.hash).researcher)
  useEffect(() => {
    if (!pendingResearcher || loading) return
    const row = search.faculty.find((f) => f.id === pendingResearcher) ?? shortlist.entries.find((e) => e.id === pendingResearcher)?.row
    if (row) setSelected(row)
    setPendingResearcher('')
  }, [pendingResearcher, loading, search.faculty, shortlist.entries])

  // Keep the address in step with the search, so copying it shares the view.
  const { country, institution, domains } = search.filters
  useEffect(() => {
    const hash = buildHash({
      query,
      sort: search.sortChosen ? sort : null,
      country,
      institution,
      domains,
      researcher: selected?.id ?? pendingResearcher,
    })
    if (hash !== window.location.hash) window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${hash}`)
  }, [query, sort, search.sortChosen, country, institution, domains, selected, pendingResearcher])

  const [filtersOpen, setFiltersOpen] = useState(false)
  const [visible, setVisible] = useState(PAGE_SIZE)

  useEffect(() => setVisible(PAGE_SIZE), [results])
  const shown = useMemo(() => results.slice(0, visible), [results, visible])
  const scoreOf = (f) => (matchScores ? matchScores[f.id] : undefined)

  return (
    <div className="flex min-h-screen flex-col bg-white">
      <Navbar
        onAboutClick={() => setAboutOpen(true)}
        onShortlistClick={() => setShortlistOpen(true)}
        shortlistCount={shortlist.entries.length}
        facultyCount={coverage.totalRows || search.faculty.length}
      />

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-8 sm:px-6 lg:py-10">
        <div className="mb-8 max-w-3xl">
          <h1 className="text-3xl font-semibold tracking-tight text-charcoal sm:text-4xl">
            Find researchers who share your interests.
          </h1>
          <p className="mt-3 text-lg leading-relaxed text-gray-600">
            Browse faculty, postdocs and research staff across the world’s top 100 universities, or let a private, in-browser model match you
            from your resume.
          </p>
        </div>

        <MatcherInterface {...matcher.matcherProps} />

        <div className="mt-10 flex flex-col gap-8 md:flex-row">
          <FilterSidebar
            {...search}
            className={`md:sticky md:top-24 md:block md:w-72 md:shrink-0 md:self-start ${filtersOpen ? 'block' : 'hidden'}`}
          />

          <section className="min-w-0 flex-1 space-y-5" aria-label="Researcher results">
            <div className="flex flex-col gap-3 sm:flex-row">
              <label className="relative flex-1">
                <span className="sr-only">Search researchers</span>
                <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-mit-gray" />
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search by name, topic, institution or publication…"
                  className="w-full rounded-xl border border-gray-200 py-2.5 pl-10 pr-3 text-sm text-charcoal shadow-sm placeholder:text-mit-gray focus:border-cardinal/50 focus:outline-none focus:ring-2 focus:ring-cardinal/15"
                />
              </label>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => setFiltersOpen((o) => !o)}
                  aria-expanded={filtersOpen}
                  className="flex items-center gap-1.5 rounded-xl border border-gray-200 px-3 py-2.5 text-sm font-medium text-charcoal shadow-sm md:hidden"
                >
                  <SlidersHorizontal className="h-4 w-4" /> Filters
                  {activeFilterCount > 0 && (
                    <span className="rounded-full bg-cardinal px-1.5 text-xs text-white">{activeFilterCount}</span>
                  )}
                </button>
                <label className="relative flex flex-1 items-center sm:flex-none">
                  <span className="sr-only">Sort by</span>
                  <ArrowUpDown className="pointer-events-none absolute left-3 h-4 w-4 text-mit-gray" />
                  <select
                    value={sort}
                    onChange={(e) => setSort(e.target.value)}
                    className="w-full appearance-none rounded-xl border border-gray-200 bg-white py-2.5 pl-9 pr-4 text-sm text-charcoal shadow-sm focus:border-cardinal/50 focus:outline-none focus:ring-2 focus:ring-cardinal/15"
                  >
                    {Object.entries(SORTS).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </div>

            {matchScores ? (
              <div className="flex items-center justify-between gap-3 rounded-xl border border-cardinal/20 bg-cardinal/5 px-4 py-3 text-sm">
                <span className="flex items-center gap-2 text-charcoal">
                  <Sparkles className="h-4 w-4 text-cardinal" />
                  Showing researchers matched to your profile.
                </span>
                <button
                  type="button"
                  onClick={matcher.clearMatches}
                  className="flex items-center gap-1 font-medium text-cardinal hover:underline"
                >
                  <X className="h-4 w-4" /> Show all researchers
                </button>
              </div>
            ) : (
              matcher.hasMatches && (
                <button
                  type="button"
                  onClick={matcher.showMatches}
                  className="flex items-center gap-1.5 text-sm font-medium text-cardinal hover:underline"
                >
                  <Sparkles className="h-4 w-4" /> Show my matches again
                </button>
              )
            )}

            {!loading && !error && coverageNote && (
              <p className="flex items-start gap-2 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-600">
                <Info className="mt-0.5 h-4 w-4 shrink-0 text-mit-gray" />
                <span>{coverageNote}</span>
              </p>
            )}

            {!loading && !error && (
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm text-mit-gray">
                  {results.length.toLocaleString()} {results.length === 1 ? 'researcher' : 'researchers'}
                </p>
                {(query.trim() || activeFilterCount > 0) && <CopyLinkButton label="Copy link to this search" />}
              </div>
            )}

            {loading ? (
              <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                {Array.from({ length: 4 }, (_, i) => (
                  <div key={i} className="h-60 animate-pulse rounded-2xl border border-gray-100 bg-gray-50" />
                ))}
              </div>
            ) : error ? (
              <p className="rounded-xl border border-cardinal/20 bg-cardinal/5 p-4 text-sm text-cardinal">{error}</p>
            ) : results.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-gray-200 px-6 py-16 text-center">
                <p className="font-medium text-charcoal">No researchers match these criteria.</p>
                <p className="mt-1 text-sm text-mit-gray">Try a broader search or clear some filters.</p>
                {(activeFilterCount > 0 || query) && (
                  <button
                    type="button"
                    onClick={() => {
                      search.resetFilters()
                      setQuery('')
                    }}
                    className="mt-4 text-sm font-medium text-cardinal hover:underline"
                  >
                    Clear search and filters
                  </button>
                )}
              </div>
            ) : (
              <>
                <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                  {shown.map((f) => (
                    <FacultyCard
                      key={f.id}
                      faculty={f}
                      matchScore={scoreOf(f)}
                      onSelect={() => setSelected(f)}
                      saved={shortlist.ids.has(f.id)}
                      onToggleSave={() => shortlist.toggle(f)}
                    />
                  ))}
                </div>
                {visible < results.length && (
                  <div className="flex justify-center pt-2">
                    <button
                      type="button"
                      onClick={() => setVisible((v) => v + PAGE_SIZE)}
                      className="rounded-xl border border-gray-200 px-5 py-2.5 text-sm font-medium text-charcoal shadow-sm transition hover:border-cardinal/40 hover:text-cardinal"
                    >
                      Show more ({(results.length - visible).toLocaleString()} remaining)
                    </button>
                  </div>
                )}
              </>
            )}
          </section>
        </div>
      </main>

      <footer className="border-t border-gray-100">
        <div className="mx-auto max-w-7xl px-4 py-6 text-xs leading-relaxed text-mit-gray sm:px-6">
          Independent open-source project, not affiliated with MIT or any institution listed.{' '}
          <button type="button" onClick={() => setAboutOpen(true)} className="font-medium text-cardinal hover:underline">
            Read the full disclaimer
          </button>
          .
          {dataStatus?.last_success_at && (
            <p className="mt-1">
              Data updated {new Date(dataStatus.last_success_at).toLocaleDateString(undefined, { dateStyle: 'medium' })}
              {dataStatus.people ? `, ${dataStatus.people.toLocaleString()} researchers` : ''}.{' '}
              <a href={dataStatus.url} target="_blank" rel="noreferrer" className="font-medium text-cardinal hover:underline">
                Pipeline status
              </a>
            </p>
          )}
        </div>
      </footer>

      <FacultyDetailModal
        faculty={selected}
        matchScore={selected ? scoreOf(selected) : undefined}
        saved={selected ? shortlist.ids.has(selected.id) : false}
        onToggleSave={shortlist.toggle}
        explain={ai.explain}
        onClose={() => setSelected(null)}
      />
      <ShortlistModal
        open={shortlistOpen}
        onClose={() => setShortlistOpen(false)}
        entries={shortlist.entries}
        saved={shortlist.saved}
        onUpdate={shortlist.update}
        onRemove={shortlist.remove}
        onOpen={(row) => {
          setShortlistOpen(false)
          setSelected(row)
        }}
      />
      <AboutModal open={aboutOpen} onClose={() => setAboutOpen(false)} />
    </div>
  )
}
