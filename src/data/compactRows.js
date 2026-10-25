// Reads the compact search files written by scripts/faculty.py (write_search_file):
//
//   { format: 'compact-v1', fields: [...], institutions: [ids], domains: [names],
//     record_files: [paths], url_prefixes: [...], rows: [[...], ...] }
//
// Each row is an array in `fields` order with trailing nulls dropped.
// institution_id, primary_domain, record_file and each entry of domains are
// indexes into the tables; a profile_url of "<n>|rest" is url_prefixes[n] + rest.
// tags are ids into the shared tags.json list (the file says "tags_file"), passed in as
// tagNames, or into the file's own "tags" table. Rows always get a tags array of names.
// Older builds publish a plain array of row objects, returned as is.

const PREFIXED_URL = /^(\d+)\|/

export function decodeSearchFile(json, tagNames = null) {
  if (Array.isArray(json)) return json
  if (json?.format !== 'compact-v1') throw new Error(`Unknown search file format: ${json?.format}`)
  const { fields, rows, institutions = [], domains = [], record_files: recordFiles = [], url_prefixes: prefixes = [] } = json
  const tables = { institution_id: institutions, primary_domain: domains, record_file: recordFiles }
  const tags = json.tags ?? tagNames ?? []
  return rows.map((values) => {
    const row = {}
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i]
      let value = values[i] ?? null
      if (value !== null) {
        if (field === 'domains') value = value.map((n) => domains[n])
        else if (field === 'tags') value = value.map((n) => tags[n]).filter(Boolean)
        else if (tables[field]) value = tables[field][value]
        else if (field === 'profile_url') {
          const m = PREFIXED_URL.exec(value)
          if (m && prefixes[m[1]] != null) value = prefixes[m[1]] + value.slice(m[0].length)
        }
      }
      row[field] = value
    }
    row.domains ??= []
    row.tags ??= []
    row.has_email = Boolean(row.email)
    return row
  })
}
