import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fetchOpenAlexProfile, parseProfileRef, profileFromOpenAlex } from '../openalexProfile.js'

test('parses ORCID and OpenAlex references', () => {
  assert.deepEqual(parseProfileRef('https://orcid.org/0000-0002-1825-009x'), { kind: 'orcid', id: '0000-0002-1825-009X' })
  assert.deepEqual(parseProfileRef(' 0000-0002-1825-0097 '), { kind: 'orcid', id: '0000-0002-1825-0097' })
  assert.deepEqual(parseProfileRef('https://openalex.org/authors/A5023888391'), { kind: 'openalex', id: 'A5023888391' })
  assert.deepEqual(parseProfileRef('a5023888391'), { kind: 'openalex', id: 'A5023888391' })
  assert.equal(parseProfileRef('Ada Lovelace'), null)
  assert.equal(parseProfileRef(''), null)
})

const AUTHOR = {
  id: 'https://openalex.org/A1',
  display_name: 'Ada Lovelace',
  topics: [
    { display_name: 'Analytical engines', count: 3 },
    { display_name: 'Computation theory', count: 9 },
  ],
}
const WORKS = { results: [{ title: 'Notes on the analytical engine' }, { title: '' }, { title: 'Bernoulli numbers by machine' }] }

test('profile puts the most frequent topics first and keeps paper titles', () => {
  const p = profileFromOpenAlex(AUTHOR, WORKS)
  assert.deepEqual(p.interests, ['Computation theory', 'Analytical engines'])
  assert.match(p.text, /^Research areas: Computation theory, Analytical engines\./)
  assert.match(p.text, /Notes on the analytical engine Bernoulli numbers by machine/)
  assert.ok(p.text.length <= 1000)
})

test('fetches author then works, and reports failures readably', async () => {
  const urls = []
  const ok = (body) => ({ ok: true, status: 200, json: async () => body })
  const fetchFn = async (url) => {
    urls.push(url)
    return url.includes('/authors/') ? ok(AUTHOR) : ok(WORKS)
  }
  const p = await fetchOpenAlexProfile('https://orcid.org/0000-0002-1825-0097', fetchFn)
  assert.equal(p.name, 'Ada Lovelace')
  assert.match(urls[0], /\/authors\/orcid:0000-0002-1825-0097/)
  assert.match(urls[1], /author\.id:A1/)

  await assert.rejects(() => fetchOpenAlexProfile('nope', fetchFn), /ORCID iD/)
  await assert.rejects(() => fetchOpenAlexProfile('A123456', async () => ({ ok: false, status: 404 })), /No OpenAlex author/)
  await assert.rejects(() => fetchOpenAlexProfile('A123456', async () => ({ ok: false, status: 503 })), /503/)
  await assert.rejects(
    () => fetchOpenAlexProfile('A123456', async (u) => (u.includes('/authors/') ? ok({ id: 'x/A9', display_name: 'Nobody' }) : ok({ results: [] }))),
    /no papers/,
  )
})
