// Builds a research profile from a public ORCID iD or OpenAlex author id, so visitors
// without a resume can match from their own publication list. The browser asks the
// public OpenAlex API (open CORS, no key) for the author's topics and recent paper
// titles; nothing is sent anywhere else.

import { QUICK_TEXT_CHARS } from './profile.js'

const API = 'https://api.openalex.org'
const ORCID = /(\d{4}-\d{4}-\d{4}-\d{3}[\dX])/i
const OPENALEX_ID = /(?:^|[/\s])(A\d{4,})\b/i
const MAX_TOPICS = 8
const MAX_WORKS = 25

/** "https://orcid.org/0000-0002-1825-0097", "0000-0002-1825-0097", "openalex.org/A5023888391", "A5023888391" -> { kind, id } | null */
export function parseProfileRef(input) {
  const text = String(input ?? '').trim()
  if (!text) return null
  const orcid = ORCID.exec(text)
  if (orcid) return { kind: 'orcid', id: orcid[1].toUpperCase() }
  const openalex = OPENALEX_ID.exec(text) ?? (/^A\d{4,}$/i.test(text) ? [null, text] : null)
  if (openalex) return { kind: 'openalex', id: openalex[1].toUpperCase() }
  return null
}

const authorUrl = (ref) =>
  `${API}/authors/${ref.kind === 'orcid' ? `orcid:${ref.id}` : ref.id}?select=id,display_name,topics`
const worksUrl = (authorId) =>
  `${API}/works?filter=author.id:${authorId}&sort=publication_date:desc&per-page=${MAX_WORKS}&select=title,publication_year`

/** Author + works responses -> { name, interests, text } like quickProfile (text is what MiniLM embeds). */
export function profileFromOpenAlex(author, works) {
  const topics = [...(author?.topics ?? [])]
    .sort((a, b) => (b.count ?? 0) - (a.count ?? 0))
    .map((t) => t.display_name)
    .filter(Boolean)
    .slice(0, MAX_TOPICS)
  const titles = (works?.results ?? []).map((w) => (w.title ?? '').trim()).filter(Boolean)
  const parts = []
  if (topics.length) parts.push(`Research areas: ${topics.join(', ')}.`)
  let used = parts.join(' ').length
  for (const title of titles) {
    if (used + title.length + 1 > QUICK_TEXT_CHARS && parts.length) break
    parts.push(title.slice(0, QUICK_TEXT_CHARS))
    used += title.length + 1
  }
  return { name: author?.display_name ?? 'OpenAlex profile', interests: topics, text: parts.join(' ').slice(0, QUICK_TEXT_CHARS) }
}

async function getJson(fetchFn, url) {
  const res = await fetchFn(url)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`OpenAlex answered ${res.status}. Try again in a moment.`)
  return res.json()
}

/** Fetches the profile for an ORCID / OpenAlex reference. Throws a readable Error when it can't. */
export async function fetchOpenAlexProfile(input, fetchFn = fetch) {
  const ref = parseProfileRef(input)
  if (!ref) throw new Error('Enter an ORCID iD (0000-0002-1825-0097) or an OpenAlex author link.')
  const author = await getJson(fetchFn, authorUrl(ref))
  if (!author?.id) throw new Error(`No OpenAlex author found for ${ref.id}.`)
  const authorId = author.id.split('/').pop()
  const works = await getJson(fetchFn, worksUrl(authorId))
  const profile = profileFromOpenAlex(author, works)
  if (!profile.text) throw new Error(`${profile.name} has no papers on OpenAlex yet.`)
  return profile
}
