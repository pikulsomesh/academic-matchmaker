import { Download, ExternalLink, Mail, Trash2 } from 'lucide-react'
import Modal from './Modal.jsx'
import { countryName } from '../lib/format.js'
import { STATUSES, shortlistToCsv } from '../lib/shortlist.js'

function downloadCsv(entries) {
  const blob = new Blob([shortlistToCsv(entries)], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `shortlist-${new Date().toISOString().slice(0, 10)}.csv`
  link.click()
  URL.revokeObjectURL(url)
}

// Saved researchers with a status and a note each, kept in this browser only.
export default function ShortlistModal({ open, onClose, entries, saved, onUpdate, onRemove, onOpen }) {
  return (
    <Modal open={open} onClose={onClose} labelledBy="shortlist-title" maxWidth="max-w-3xl">
      <div className="space-y-5 p-6 pr-14 sm:p-8 sm:pr-16">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 id="shortlist-title" className="text-2xl font-semibold tracking-tight text-charcoal">
              Your shortlist
            </h2>
            <p className="mt-1 text-sm text-mit-gray">
              Saved in this browser only. Nothing is sent anywhere, and clearing site data removes it.
            </p>
          </div>
          {entries.length > 0 && (
            <button
              type="button"
              onClick={() => downloadCsv(entries)}
              className="flex items-center gap-1.5 rounded-xl border border-gray-200 px-3 py-2 text-sm font-medium text-charcoal transition hover:border-cardinal/40 hover:text-cardinal"
            >
              <Download className="h-4 w-4" /> Download CSV
            </button>
          )}
        </div>

        {!saved && (
          <p className="rounded-xl border border-cardinal/20 bg-cardinal/5 px-4 py-3 text-sm text-cardinal">
            Your browser isn’t letting this site store the list, so it will be lost when you close the page. Download the CSV to keep it.
          </p>
        )}

        {entries.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-gray-200 px-6 py-12 text-center text-sm text-mit-gray">
            Star a researcher on any card to keep them here, with a note and a status for tracking who you’ve contacted.
          </p>
        ) : (
          <ul className="space-y-4">
            {entries.map((e) => {
              const { row } = e
              const inst = row.institution ?? {}
              return (
                <li key={e.id} className="space-y-3 rounded-2xl border border-gray-100 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <button
                        type="button"
                        onClick={() => onOpen(row)}
                        className="max-w-full truncate text-left text-base font-semibold text-charcoal hover:text-cardinal"
                      >
                        {row.name}
                      </button>
                      <p className="truncate text-sm text-gray-600">
                        {[row.title, inst.name, inst.country_code && countryName(inst.country_code)].filter(Boolean).join(' · ')}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => onRemove(e.id)}
                      aria-label={`Remove ${row.name} from the shortlist`}
                      className="rounded-lg p-1.5 text-mit-gray transition hover:bg-gray-50 hover:text-cardinal"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                  <div className="flex flex-wrap items-center gap-3 text-sm">
                    {row.email && (
                      <a href={`mailto:${row.email}`} className="flex items-center gap-1.5 text-cardinal hover:underline">
                        <Mail className="h-4 w-4" /> {row.email}
                      </a>
                    )}
                    {row.profile_url && (
                      <a
                        href={row.profile_url}
                        target="_blank"
                        rel="noreferrer"
                        className="flex items-center gap-1.5 text-charcoal hover:text-cardinal"
                      >
                        <ExternalLink className="h-4 w-4" /> Profile
                      </a>
                    )}
                    <label className="ml-auto flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-mit-gray">
                      Status
                      <select
                        value={e.status}
                        onChange={(ev) => onUpdate(e.id, { status: ev.target.value })}
                        className="rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-sm font-normal normal-case tracking-normal text-charcoal focus:border-cardinal/50 focus:outline-none focus:ring-2 focus:ring-cardinal/15"
                      >
                        {STATUSES.map((s) => (
                          <option key={s}>{s}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <textarea
                    value={e.note}
                    onChange={(ev) => onUpdate(e.id, { note: ev.target.value })}
                    rows={2}
                    maxLength={2000}
                    placeholder="Notes: a paper to mention, a question to ask, when you emailed…"
                    aria-label={`Notes on ${row.name}`}
                    className="w-full resize-y rounded-xl border border-gray-200 px-3 py-2 text-sm text-charcoal placeholder:text-mit-gray focus:border-cardinal/50 focus:outline-none focus:ring-2 focus:ring-cardinal/15"
                  />
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </Modal>
  )
}
