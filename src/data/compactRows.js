// Reads the compact search files written by scripts/faculty.py (write_search_file):
//
//   { format: 'compact-v1', fields: [...], institutions: [ids], domains: [names],
//     record_files: [paths], url_prefixes: [...], rows: [[...], ...] }
//
// Each row is an array in `fields` order with trailing nulls dropped.
// institution_id, primary_domain, record_file and each entry of domains are
// indexes into the tables; a profile_url of "<n>|rest" is url_prefixes[n] + rest.
// Older builds publish a plain array of row objects, returned as is.

const PREFIXED_URL = /^(\d+)\|/

export function decodeSearchFile(json) {
  if (Array.isArray(json)) return json
  if (json?.format !== 'compact-v1') throw new Error(`Unknown search file format: ${json?.format}`)
  const { fields, rows, institutions = [], domains = [], record_files: recordFiles = [], url_prefixes: prefixes = [] } = json
  const tables = { institution_id: institutions, primary_domain: domains, record_file: recordFiles }
  return rows.map((values) => {
    const row = {}
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i]
      let value = values[i] ?? null
      if (value !== null) {
        if (field === 'domains') value = value.map((n) => domains[n])
        else if (tables[field]) value = tables[field][value]
        else if (field === 'profile_url') {
          const m = PREFIXED_URL.exec(value)
          if (m && prefixes[m[1]] != null) value = prefixes[m[1]] + value.slice(m[0].length)
        }
      }
      row[field] = value
    }
    row.domains ??= []
    row.has_email = Boolean(row.email)
    return row
  })
}
