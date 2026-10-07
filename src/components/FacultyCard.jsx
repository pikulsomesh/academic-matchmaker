import { BookOpen, ExternalLink, Mail, MapPin, Quote } from 'lucide-react'
import { countryName, formatCount } from '../lib/format.js'
import { LikelyPIBadge, RoleLine } from './RoleSignals.jsx'

// `onShowEmail` opens the full record when the catalog row only says an email exists.
export function ContactLinks({ faculty, size = 'sm', onShowEmail }) {
  const base =
    size === 'lg'
      ? 'flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition'
      : 'flex min-w-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium transition'
  const stop = (e) => e.stopPropagation()
  return (
    <div className="flex flex-wrap gap-2">
      {faculty.email ? (
        <a
          href={`mailto:${faculty.email}`}
          onClick={stop}
          className={`${base} bg-cardinal text-white hover:bg-cardinal/90`}
          title={faculty.email}
        >
          <Mail className="h-4 w-4 shrink-0" />
          <span className="truncate">{faculty.email}</span>
        </a>
      ) : faculty.has_email && onShowEmail ? (
        <button
          type="button"
          onClick={(e) => {
            stop(e)
            onShowEmail()
          }}
          className={`${base} bg-cardinal text-white hover:bg-cardinal/90`}
        >
          <Mail className="h-4 w-4 shrink-0" /> Show email
        </button>
      ) : (
        <span className={`${base} border border-dashed border-gray-200 text-mit-gray`}>
          <Mail className="h-4 w-4 shrink-0" /> {faculty.has_email ? 'Loading email…' : 'Email not verified'}
        </span>
      )}
      {faculty.profile_url ? (
        <a
          href={faculty.profile_url}
          target="_blank"
          rel="noreferrer"
          onClick={stop}
          className={`${base} border border-gray-200 text-charcoal hover:border-cardinal/40 hover:text-cardinal`}
        >
          <ExternalLink className="h-4 w-4 shrink-0" /> Profile
        </a>
      ) : (
        <span className={`${base} border border-dashed border-gray-200 text-mit-gray`}>
          <ExternalLink className="h-4 w-4 shrink-0" /> No profile link
        </span>
      )}
    </div>
  )
}

export default function FacultyCard({ faculty, onSelect, matchScore }) {
  const inst = faculty.institution ?? {}
  const domains = (faculty.domains ?? []).slice(0, 3)
  const latest = faculty.recent_publications?.[0]

  return (
    <article
      onClick={onSelect}
      className="group flex cursor-pointer flex-col gap-4 rounded-2xl border border-gray-100 bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-gray-200 hover:shadow-md focus-within:ring-2 focus-within:ring-cardinal/20"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-lg font-semibold tracking-tight text-charcoal group-hover:text-cardinal">
            {/* The card itself is clickable for pointer users; this button is the keyboard / screen-reader target. */}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onSelect()
              }}
              className="max-w-full truncate text-left focus:outline-none"
            >
              {faculty.name}
            </button>
          </h3>
          {faculty.title && <p className="mt-0.5 line-clamp-2 text-sm text-gray-600">{faculty.title}</p>}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          {matchScore != null && (
            <span className="rounded-full bg-cardinal/10 px-2.5 py-1 text-xs font-semibold text-cardinal">
              {Math.round(matchScore * 100)}% match
            </span>
          )}
          <LikelyPIBadge faculty={faculty} />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-mit-gray">
        <span className="flex min-w-0 items-center gap-1.5">
          <MapPin className="h-4 w-4 shrink-0" />
          <span className="truncate">
            {inst.name}
            {inst.country_code && ` · ${countryName(inst.country_code)}`}
          </span>
        </span>
        {inst.rank != null && <span className="text-xs font-medium">#{inst.rank}</span>}
        <span className="flex items-center gap-1.5">
          <Quote className="h-3.5 w-3.5" /> {formatCount(faculty.citation_count)} citations
        </span>
      </div>

      <RoleLine faculty={faculty} />

      {domains.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {domains.map((name) => (
            <span
              key={name}
              className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                name === faculty.primary_domain ? 'bg-charcoal text-white' : 'bg-gray-100 text-gray-700'
              }`}
            >
              {name}
            </span>
          ))}
        </div>
      )}

      {latest && (
        <p className="flex items-start gap-1.5 text-sm text-gray-600">
          <BookOpen className="mt-0.5 h-4 w-4 shrink-0 text-mit-gray" />
          <span className="line-clamp-2">
            {latest.title}
            {latest.year && <span className="text-mit-gray"> ({latest.year})</span>}
          </span>
        </p>
      )}

      <div className="mt-auto border-t border-gray-100 pt-4">
        <ContactLinks faculty={faculty} onShowEmail={onSelect} />
      </div>
    </article>
  )
}
