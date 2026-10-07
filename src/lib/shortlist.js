// The visitor's shortlist: researchers they starred, with a status and a note
// each. It lives in this browser's localStorage only (nothing is sent anywhere)
// and can be exported as CSV. Every entry keeps a snapshot of the catalog row
// so the list still opens a profile on large builds where the row isn't loaded.

export const STORAGE_KEY = 'matchmaker.shortlist.v1'
export const STATUSES = ['To contact', 'Emailed', 'Replied', 'Not a fit']

// Catalog-row fields worth keeping; anything else (full publication lists) is dropped.
const ROW_FIELDS = [
  'id', 'name', 'title', 'email', 'profile_url', 'has_email', 'citation_count', 'primary_domain', 'domains',
  'institution', 'record_file', 'seniority_score', 'first_author_recent', 'last_author_recent', 'recent_works',
  'last_publication_year',
]

export function snapshotRow(row) {
  const out = {}
  for (const key of ROW_FIELDS) if (row[key] !== undefined) out[key] = row[key]
  return out
}

export function newEntry(row, now = new Date()) {
  return { id: row.id, row: snapshotRow(row), status: STATUSES[0], note: '', savedAt: now.toISOString() }
}

export function readShortlist(storage = globalThis.localStorage) {
  try {
    const list = JSON.parse(storage?.getItem(STORAGE_KEY) ?? '[]')
    return Array.isArray(list) ? list.filter((e) => e && e.id && e.row) : []
  } catch {
    return []
  }
}

// Returns false when storage is unavailable (private window, quota) so the UI can say so.
export function writeShortlist(list, storage = globalThis.localStorage) {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(list))
    return true
  } catch {
    return false
  }
}

// A cell that starts with = + - @ is read as a formula by Excel and Sheets; a leading apostrophe defuses it.
export function csvCell(value) {
  let text = value == null ? '' : String(value)
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export const CSV_COLUMNS = ['Name', 'Title', 'University', 'Country', 'University rank', 'Email', 'Profile link', 'Status', 'Notes', 'Saved']

export function shortlistToCsv(list) {
  const rows = list.map(({ row, status, note, savedAt }) => [
    row.name,
    row.title,
    row.institution?.name,
    row.institution?.country_code,
    row.institution?.rank,
    row.email,
    row.profile_url,
    status,
    note,
    savedAt?.slice(0, 10),
  ])
  return [CSV_COLUMNS, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'
}
