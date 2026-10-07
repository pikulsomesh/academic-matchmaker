import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CSV_COLUMNS, STATUSES, csvCell, newEntry, readShortlist, shortlistToCsv, snapshotRow, writeShortlist } from '../shortlist.js'
import { buildHash, parseHash } from '../urlState.js'
import { findContactUrl } from '../contact.js'
import { rankEvidence, sharedInterests } from '../../ai/explain.js'

const ROW = {
  id: 'A1',
  name: 'Ada Lovelace',
  title: 'Professor, Math',
  email: 'ada@uni.edu',
  profile_url: 'https://orcid.org/0000-0001',
  institution: { id: 'I1', name: 'Uni, The', country_code: 'GB', rank: 4, homepage_url: 'https://www.uni.ac.uk/' },
  recent_publications: [{ title: 'big' }],
  record_file: 'faculty/I1/0.json',
}

function memoryStorage() {
  const data = new Map()
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v) }
}

test('shortlist entries keep a snapshot without heavy fields and survive storage', () => {
  const entry = newEntry(ROW, new Date('2026-10-07T12:00:00Z'))
  assert.equal(entry.status, STATUSES[0])
  assert.equal(entry.row.recent_publications, undefined)
  assert.equal(entry.row.record_file, 'faculty/I1/0.json')
  const storage = memoryStorage()
  assert.equal(writeShortlist([entry], storage), true)
  assert.deepEqual(readShortlist(storage), [entry])
})

test('shortlist storage tolerates garbage and missing storage', () => {
  const storage = memoryStorage()
  storage.setItem('matchmaker.shortlist.v1', '{not json')
  assert.deepEqual(readShortlist(storage), [])
  storage.setItem('matchmaker.shortlist.v1', JSON.stringify([{ id: 'x' }, null, 'y']))
  assert.deepEqual(readShortlist(storage), [])
  assert.deepEqual(readShortlist(undefined), [])
  assert.equal(writeShortlist([], { setItem() { throw new Error('quota') } }), false)
})

test('CSV quotes commas, quotes and newlines and defuses formulas', () => {
  assert.equal(csvCell('a,b'), '"a,b"')
  assert.equal(csvCell('say "hi"'), '"say ""hi"""')
  assert.equal(csvCell('=SUM(A1)'), "'=SUM(A1)")
  assert.equal(csvCell(null), '')
  assert.equal(csvCell(4), '4')
  const entry = { ...newEntry(ROW, new Date('2026-10-07T12:00:00Z')), note: 'ask about\nrotation', status: 'Emailed' }
  const lines = shortlistToCsv([entry]).split('\r\n')
  assert.equal(lines[0], CSV_COLUMNS.join(','))
  assert.equal(
    lines.slice(1).join('\r\n'),
    'Ada Lovelace,"Professor, Math","Uni, The",GB,4,ada@uni.edu,https://orcid.org/0000-0001,Emailed,"ask about\nrotation",2026-10-07\r\n',
  )
  assert.deepEqual(Object.keys(snapshotRow(ROW)).includes('recent_publications'), false)
})

test('hash state round-trips and ignores unknown sorts', () => {
  const state = { query: 'graph neural', sort: 'citations', country: 'US', institution: 'MIT & Co', domains: ['Physics', 'Optics'], researcher: 'A5029' }
  const hash = buildHash(state)
  assert.deepEqual(parseHash(hash), state)
  assert.equal(buildHash({}), '')
  assert.equal(parseHash('#sort=evil').sort, null)
  assert.deepEqual(parseHash(''), { query: '', sort: null, country: '', institution: '', domains: [], researcher: '' })
})

test('find contact searches the university site, or the university name without a homepage', () => {
  const url = new URL(findContactUrl(ROW))
  assert.equal(url.searchParams.get('q'), '"Ada Lovelace" site:uni.ac.uk')
  const bare = new URL(findContactUrl({ name: 'Bo', institution: { name: 'Some U' } }))
  assert.equal(bare.searchParams.get('q'), '"Bo" Some U')
})

test('rankEvidence orders areas and papers by similarity to the profile', () => {
  const dim = 3
  const rows = [
    [1, 0, 0], // profile
    [0, 1, 0], // area: unrelated
    [0.9, 0.1, 0], // area: close
    [0, 0, 1], // paper: unrelated
    [1, 0, 0], // paper: same
  ]
  const matrix = Float32Array.from(rows.flat())
  const out = rankEvidence({ dim, matrix, areas: ['Botany', 'Optics'], papers: [{ title: 'Off topic', year: 2020 }, { title: 'On topic', year: 2025 }] })
  assert.deepEqual(out.areas.map((a) => a.name), ['Optics', 'Botany'])
  assert.deepEqual(out.papers.map((p) => p.title), ['On topic', 'Off topic'])
  assert.equal(out.papers[0].year, 2025)
  assert.ok(out.papers[0].score > 0.99)
})

test('sharedInterests finds interests whose words all appear in the researcher’s work', () => {
  const texts = ['Graph neural networks for catalyst discovery', 'Materials Science']
  assert.deepEqual(sharedInterests(['graph neural networks', 'catalyst design', 'materials science', 'the of'], texts), [
    'graph neural networks',
    'materials science',
  ])
})
