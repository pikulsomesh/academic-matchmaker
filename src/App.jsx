import { useEffect, useMemo, useState } from 'react'
import { ArrowUpDown, Search, SlidersHorizontal, Sparkles, X } from 'lucide-react'
import Navbar from './components/Navbar.jsx'
import FilterSidebar from './components/FilterSidebar.jsx'
import MatcherInterface from './components/MatcherInterface.jsx'
import FacultyCard from './components/FacultyCard.jsx'
import FacultyDetailModal from './components/FacultyDetailModal.jsx'
import AboutModal from './components/AboutModal.jsx'
import useFacultySearch, { SORTS } from './hooks/useFacultySearch.js'
import useLocalAI from './hooks/useLocalAI.js'
import useMatcherBridge from './hooks/useMatcherBridge.js'

const PAGE_SIZE = 24

export default function App() {
  const search = useFacultySearch()
  const { results, loading, error, query, setQuery, sort, setSort, activeFilterCount, matchScores } = search
  const ai = useLocalAI(search.faculty)
  const matcher = useMatcherBridge(ai)
  const { setMatchScores } = search
  useEffect(() => setMatchScores(matcher.matchScores), [matcher.matchScores, setMatchScores])

  const [selected, setSelected] = useState(null)
  const [aboutOpen, setAboutOpen] = useState(false)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [visible, setVisible] = useState(PAGE_SIZE)

  useEffect(() => setVisible(PAGE_SIZE), [results])
  const shown = useMemo(() => results.slice(0, visible), [results, visible])
  const scoreOf = (f) => (matchScores ? matchScores[f.id] : undefined)

  return (
    <div className="flex min-h-screen flex-col bg-white">
      <Navbar onAboutClick={() => setAboutOpen(true)} facultyCount={search.faculty.length} />

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-8 sm:px-6 lg:py-10">
        <div className="mb-8 max-w-3xl">
          <h1 className="text-3xl font-semibold tracking-tight text-charcoal sm:text-4xl">
            Find faculty who share your research interests.
          </h1>
          <p className="mt-3 text-lg leading-relaxed text-gray-600">
            Browse professors across the world’s top 100 universities, or let a private, in-browser model match you
            from your resume.
          </p>
        </div>

        <MatcherInterface {...matcher.matcherProps} />

        <div className="mt-10 flex flex-col gap-8 md:flex-row">
          <FilterSidebar
            {...search}
            className={`md:sticky md:top-24 md:block md:w-72 md:shrink-0 md:self-start ${filtersOpen ? 'block' : 'hidden'}`}
          />

          <section className="min-w-0 flex-1 space-y-5" aria-label="Faculty results">
            <div className="flex flex-col gap-3 sm:flex-row">
              <label className="relative flex-1">
                <span className="sr-only">Search faculty</span>
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
                  Showing faculty matched to your profile.
                </span>
                <button
                  type="button"
                  onClick={matcher.clearMatches}
                  className="flex items-center gap-1 font-medium text-cardinal hover:underline"
                >
                  <X className="h-4 w-4" /> Show all faculty
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

            {!loading && !error && (
              <p className="text-sm text-mit-gray">
                {results.length.toLocaleString()} {results.length === 1 ? 'faculty member' : 'faculty members'}
              </p>
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
                <p className="font-medium text-charcoal">No faculty match these criteria.</p>
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
                    <FacultyCard key={f.id} faculty={f} matchScore={scoreOf(f)} onSelect={() => setSelected(f)} />
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
        </div>
      </footer>

      <FacultyDetailModal
        faculty={selected}
        matchScore={selected ? scoreOf(selected) : undefined}
        onClose={() => setSelected(null)}
      />
      <AboutModal open={aboutOpen} onClose={() => setAboutOpen(false)} />
    </div>
  )
}
