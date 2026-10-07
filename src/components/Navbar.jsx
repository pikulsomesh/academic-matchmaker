import { GraduationCap, Info, Star } from 'lucide-react'

export default function Navbar({ onAboutClick, onShortlistClick, shortlistCount = 0, facultyCount }) {
  return (
    <header className="sticky top-0 z-30 border-b border-gray-100 bg-white/90 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
        <a href="./" className="flex min-w-0 items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-cardinal text-white">
            <GraduationCap className="h-5 w-5" />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-base font-semibold tracking-tight text-charcoal sm:text-lg">
              Global Academic Matchmaker
            </span>
            <span className="hidden text-xs text-mit-gray sm:block">
              {facultyCount ? `${facultyCount.toLocaleString()} researchers · ` : ''}Top 100 global universities
            </span>
          </span>
        </a>
        <div className="flex shrink-0 items-center gap-2">
        {onShortlistClick && (
          <button
            type="button"
            onClick={onShortlistClick}
            className="flex shrink-0 items-center gap-1.5 rounded-xl border border-gray-100 px-3 py-2 text-sm font-medium text-charcoal transition hover:border-cardinal/30 hover:text-cardinal"
          >
            <Star className={`h-4 w-4 ${shortlistCount ? 'fill-amber-400 text-amber-500' : ''}`} /> Shortlist
            {shortlistCount > 0 && <span className="rounded-full bg-cardinal px-1.5 text-xs text-white">{shortlistCount}</span>}
          </button>
        )}
        <button
          type="button"
          onClick={onAboutClick}
          className="flex shrink-0 items-center gap-1.5 rounded-xl border border-gray-100 px-3 py-2 text-sm font-medium text-charcoal transition hover:border-cardinal/30 hover:text-cardinal"
        >
          <Info className="h-4 w-4" /> About
        </button>
        </div>
      </div>
    </header>
  )
}
