import { GraduationCap, Info } from 'lucide-react'

// Stub: the UI thread replaces this with the full Navbar.
export default function Navbar({ onAboutClick }) {
  return (
    <header className="border-b border-gray-100">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
        <div className="flex items-center gap-2">
          <GraduationCap className="h-6 w-6 text-cardinal" />
          <span className="text-lg font-semibold tracking-tight text-charcoal">
            Global Academic Matchmaker
          </span>
        </div>
        <button
          onClick={onAboutClick}
          className="flex items-center gap-1 text-sm text-mit-gray hover:text-cardinal"
        >
          <Info className="h-4 w-4" /> About
        </button>
      </div>
    </header>
  )
}
