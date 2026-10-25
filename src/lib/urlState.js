// Search state in the page's hash so a link reproduces the view:
//   #q=graph+neural&sort=citations&country=US&inst=Stanford+University&domains=Physics,Optics&r=A5029
//   &c=gastrointestinal|peptide&cm=any   (concept chips, and "match any" instead of all)
// A hash needs no server support on GitHub Pages and never reaches a server.

export const URL_SORTS = ['pi', 'relevance', 'citations', 'rank', 'name']

export function parseHash(hash = '') {
  const params = new URLSearchParams(String(hash).replace(/^#/, ''))
  const sort = params.get('sort')
  return {
    query: params.get('q') ?? '',
    sort: URL_SORTS.includes(sort) ? sort : null,
    country: params.get('country') ?? '',
    institution: params.get('inst') ?? '',
    domains: (params.get('domains') ?? '').split('|').filter(Boolean),
    concepts: (params.get('c') ?? '').split('|').filter(Boolean),
    conceptMode: params.get('cm') === 'any' ? 'any' : 'all',
    researcher: params.get('r') ?? '',
    view: params.get('view') === 'demo' ? 'demo' : 'search',
  }
}

// `sort` is only written once the visitor picked one, so a shared link doesn't pin the default.
export function buildHash({
  query = '',
  sort = null,
  country = '',
  institution = '',
  domains = [],
  concepts = [],
  conceptMode = 'all',
  researcher = '',
  view = 'search',
}) {
  const params = new URLSearchParams()
  if (query.trim()) params.set('q', query.trim())
  if (sort) params.set('sort', sort)
  if (country) params.set('country', country)
  if (institution) params.set('inst', institution)
  if (domains.length) params.set('domains', domains.join('|'))
  if (concepts.length) params.set('c', concepts.join('|'))
  if (concepts.length && conceptMode === 'any') params.set('cm', 'any')
  if (researcher) params.set('r', researcher)
  if (view === 'demo') params.set('view', 'demo')
  const text = params.toString()
  return text ? `#${text}` : ''
}
