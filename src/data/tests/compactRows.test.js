import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decodeSearchFile } from '../compactRows.js'

// Written by scripts/faculty.py compact_search_file() from the two rows below
// (CompactSearchFileTests.ROWS in scripts/tests/test_pipeline.py).
const COMPACT = {
  format: 'compact-v1',
  fields: ['id', 'name', 'title', 'institution_id', 'primary_domain', 'domains', 'citation_count', 'email', 'profile_url',
    'seniority_score', 'first_author_recent', 'last_author_recent', 'recent_works', 'last_publication_year', 'record_file'],
  institutions: ['I1', 'I2'],
  domains: ['Physics', 'Optics'],
  record_files: ['faculty/I1/0.json'],
  url_prefixes: ['https://orcid.org/', 'https://openalex.org/'],
  rows: [
    ['A1', 'Ada', 'Professor', 0, 0, [1, 0], 900, 'ada@u.edu', '0|0000-0001', 80, 1, 3, 4, 2026, 0],
    ['A2', 'Bo', null, 1, null, null, 0, null, 'https://u.edu/~bo|x'],
  ],
}

const ROWS = [
  { id: 'A1', name: 'Ada', title: 'Professor', institution_id: 'I1', primary_domain: 'Physics', domains: ['Optics', 'Physics'],
    citation_count: 900, email: 'ada@u.edu', profile_url: 'https://orcid.org/0000-0001', has_email: true, seniority_score: 80,
    first_author_recent: 1, last_author_recent: 3, recent_works: 4, last_publication_year: 2026, record_file: 'faculty/I1/0.json' },
  { id: 'A2', name: 'Bo', title: null, institution_id: 'I2', primary_domain: null, domains: [], citation_count: 0, email: null,
    profile_url: 'https://u.edu/~bo|x', has_email: false, seniority_score: null, first_author_recent: null,
    last_author_recent: null, recent_works: null, last_publication_year: null, record_file: null },
]

test('decodes compact rows to the same objects the pipeline encoded', () => {
  assert.deepEqual(decodeSearchFile(COMPACT), ROWS)
})

test('passes older plain-array files through', () => {
  assert.equal(decodeSearchFile(ROWS), ROWS)
})

test('rejects unknown formats', () => {
  assert.throws(() => decodeSearchFile({ format: 'compact-v9', rows: [] }), /Unknown search file format/)
})
