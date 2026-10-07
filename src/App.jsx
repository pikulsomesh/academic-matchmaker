import { useState } from 'react'
import Navbar from './components/Navbar.jsx'
import FilterSidebar from './components/FilterSidebar.jsx'
import MatcherInterface from './components/MatcherInterface.jsx'
import FacultyCard from './components/FacultyCard.jsx'
import FacultyDetailModal from './components/FacultyDetailModal.jsx'
import AboutModal from './components/AboutModal.jsx'
import useFacultySearch from './hooks/useFacultySearch.js'
import useLocalAI from './hooks/useLocalAI.js'

export default function App() {
  const { faculty, loading } = useFacultySearch()
  const ai = useLocalAI(faculty)
  // Ranked by research match once the matcher has a profile, otherwise as loaded.
  const results = ai.matches.length ? ai.matches : faculty.map((f) => ({ faculty: f, score: null }))
  const [selected, setSelected] = useState(null)
  const [aboutOpen, setAboutOpen] = useState(false)

  return (
    <div className="min-h-screen">
      <Navbar onAboutClick={() => setAboutOpen(true)} />
      <main className="mx-auto flex max-w-7xl gap-8 px-6 py-8">
        <FilterSidebar />
        <section className="flex-1 space-y-6">
          <MatcherInterface ai={ai} />
          {loading ? (
            <p className="text-mit-gray">Loading faculty…</p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {results.map(({ faculty: f, score }) => (
                <FacultyCard key={f.id} faculty={f} matchScore={score} onSelect={() => setSelected(f)} />
              ))}
            </div>
          )}
        </section>
      </main>
      <FacultyDetailModal faculty={selected} onClose={() => setSelected(null)} />
      <AboutModal open={aboutOpen} onClose={() => setAboutOpen(false)} />
    </div>
  )
}
