import { BadgeCheck, Coins, Crown, FlaskConical, TrendingUp, Users } from 'lucide-react'
import { labSignals } from '../lib/labSignals.js'
import { roleSignals } from '../lib/roles.js'

const LEAD_HINT = 'Last (senior) author: usually the lab head who sets direction and holds the funding.'
const WORK_HINT = 'First author: usually the person who did the work and can discuss the details.'

export function LikelyPIBadge({ faculty, className = '' }) {
  if (!roleSignals(faculty).likelyPI) return null
  return (
    <span
      title="Estimated from h-index, publication record, citations and how often they are senior author. Likely runs a group."
      className={`inline-flex shrink-0 items-center gap-1 rounded-full border border-cardinal/30 px-2.5 py-1 text-xs font-semibold text-cardinal ${className}`}
    >
      <BadgeCheck className="h-3.5 w-3.5" /> Likely PI
    </span>
  )
}

/** One-line authorship summary for cards. Renders nothing for records without the signals. */
export function RoleLine({ faculty }) {
  const s = roleSignals(faculty)
  if (!s.hasAuthorship) return null
  return (
    <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-600">
      {s.lastAuthor > 0 && (
        <span className="flex items-center gap-1.5" title={LEAD_HINT}>
          <Crown className="h-3.5 w-3.5 text-mit-gray" /> Senior author on {s.lastAuthor}
        </span>
      )}
      {s.firstAuthor > 0 && (
        <span className="flex items-center gap-1.5" title={WORK_HINT}>
          <FlaskConical className="h-3.5 w-3.5 text-mit-gray" /> First author on {s.firstAuthor}
        </span>
      )}
      <span className="text-mit-gray">recent papers</span>
    </p>
  )
}

function Stat({ icon: Icon, label, value, hint }) {
  return (
    <div className="rounded-xl border border-gray-100 p-4">
      <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-mit-gray">
        <Icon className="h-3.5 w-3.5" /> {label}
      </p>
      <p className="mt-1 text-2xl font-semibold tracking-tight text-charcoal">{value}</p>
      <p className="mt-1 text-xs leading-relaxed text-gray-600">{hint}</p>
    </div>
  )
}

/** Detail-modal section: who leads vs. who does the work. Renders nothing without the signals. */
export function RoleSection({ faculty }) {
  const s = roleSignals(faculty)
  if (!s.hasAuthorship && s.piScore == null) return null
  const of =
    s.knownPapers && s.knownPapers >= Math.max(s.firstAuthor ?? 0, s.lastAuthor ?? 0) ? ` of ${s.knownPapers}` : ''
  return (
    <section className="space-y-3 p-6 sm:px-8">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-mit-gray">Role in their research</h3>
        <LikelyPIBadge faculty={faculty} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {s.hasAuthorship && (
          <Stat
            icon={Crown}
            label="Leads the work"
            value={`${s.lastAuthor ?? 0}${of}`}
            hint="Recent papers as last (senior) author. Senior authors usually run the lab and hold the funding, so they're who to ask about open positions."
          />
        )}
        {s.hasAuthorship && (
          <Stat
            icon={FlaskConical}
            label="Does the work"
            value={`${s.firstAuthor ?? 0}${of}`}
            hint="Recent papers as first author. First authors usually ran the project and can talk through the details."
          />
        )}
      </div>
      {s.piScore != null && (
        <div>
          <div className="flex justify-between text-sm">
            <span className="font-medium text-charcoal">Seniority</span>
            <span className="text-mit-gray">{Math.round(s.piScore)} / 100</span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-gray-100">
            <div className="h-full rounded-full bg-charcoal" style={{ width: `${Math.min(100, s.piScore)}%` }} />
          </div>
        </div>
      )}
      <p className="text-xs leading-relaxed text-mit-gray">
        Estimated from h-index, publication record, citations and author order on OpenAlex. Some fields, such as economics and mathematics, list authors
        alphabetically, so treat this as a hint, not a title.
      </p>
    </section>
  )
}

const TREND = {
  rising: 'Publishing more than in the three years before.',
  steady: 'Publishing at a steady pace.',
  declining: 'Publishing less than in the three years before.',
}

/** Detail-modal section about the group: turnover of first authors, funders, output trend. */
export function LabSection({ faculty }) {
  const s = labSignals(faculty)
  if (!s.any) return null
  return (
    <section className="space-y-3 p-6 sm:px-8">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-mit-gray">Their lab</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        {s.firstAuthors != null && (
          <Stat
            icon={Users}
            label="Different first authors"
            value={`${s.firstAuthors} of ${s.papers}`}
            hint={`${s.firstAuthors} different people were first author on their last ${s.papers} senior-author papers. More names usually means a bigger group that brings in new people.`}
          />
        )}
        {s.trend && (
          <Stat
            icon={TrendingUp}
            label="Recent output"
            value={`${s.recent} papers`}
            hint={`${TREND[s.trend]} ${s.recent} in the last three full years, ${s.prior} in the three before.`}
          />
        )}
      </div>
      {s.funders.length > 0 && (
        <p className="flex flex-wrap items-center gap-2 text-sm text-charcoal">
          <Coins className="h-4 w-4 text-mit-gray" /> <span className="font-medium">Recent funders</span>
          {s.funders.map((name) => (
            <span key={name} className="rounded-full border border-gray-200 px-2.5 py-0.5 text-xs">
              {name}
            </span>
          ))}
        </p>
      )}
      <p className="text-xs leading-relaxed text-mit-gray">From OpenAlex author order, funder and yearly output data; a hint about the group, not a measure of it.</p>
    </section>
  )
}
