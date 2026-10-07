import { ExternalLink, Mail } from 'lucide-react'

// Stub: the UI thread replaces this with the full card design.
export default function FacultyCard({ faculty, onSelect }) {
  return (
    <article
      onClick={onSelect}
      className="cursor-pointer rounded-xl border border-gray-100 p-4 shadow-sm hover:border-gray-200"
    >
      <h3 className="font-semibold tracking-tight text-charcoal">{faculty.name}</h3>
      <p className="text-sm text-mit-gray">{faculty.institution.name}</p>
      <div className="mt-3 flex gap-4 text-sm">
        {faculty.email && (
          <a href={`mailto:${faculty.email}`} onClick={(e) => e.stopPropagation()} className="flex items-center gap-1 text-cardinal">
            <Mail className="h-4 w-4" /> {faculty.email}
          </a>
        )}
        {faculty.profile_url && (
          <a href={faculty.profile_url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="flex items-center gap-1 text-cardinal">
            <ExternalLink className="h-4 w-4" /> Profile
          </a>
        )}
      </div>
    </article>
  )
}
