const regionNames =
  typeof Intl !== 'undefined' && Intl.DisplayNames ? new Intl.DisplayNames(['en'], { type: 'region' }) : null

export function countryName(code) {
  if (!code) return ''
  try {
    return regionNames?.of(code) ?? code
  } catch {
    return code
  }
}

export function formatCount(n) {
  return new Intl.NumberFormat('en', { notation: n >= 10000 ? 'compact' : 'standard' }).format(n ?? 0)
}

// Domain weights sorted strongest first, as [name, weight] pairs.
export function sortedWeights(weights) {
  return Object.entries(weights ?? {}).sort((a, b) => b[1] - a[1])
}
