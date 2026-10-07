// Only a small share of researchers have a verified email. For the rest the card
// offers a web search scoped to their university's site, which usually finds the
// department directory entry or personal page.

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

export function findContactUrl(faculty) {
  const inst = faculty?.institution ?? {}
  const host = hostOf(inst.homepage_url)
  const terms = [`"${faculty?.name ?? ''}"`, host ? `site:${host}` : inst.name ?? '']
  return `https://www.google.com/search?q=${encodeURIComponent(terms.filter(Boolean).join(' '))}`
}
