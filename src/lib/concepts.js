// Concept matching: what a visitor asks for ("gastrointestinal + peptide") against the
// OpenAlex tags each researcher carries (row.tags, strongest first; see scripts/tags.py).
//
// A concept matches a tag when every significant word of the concept, or of one of its
// synonyms, appears in the tag's name, in one of OpenAlex's keywords for that topic, or in
// its subfield. Generic words ("strategy", "analysis") never count on their own, and tags
// that a large share of the database carries count for less. Concepts are ANDed: a person
// matches when every concept finds one of their tags (or, with mode 'any', at least one).
// Rows without tags (data built before tags existed) fall back to research areas and titles.
// Pure functions, so they run in Node tests.

// Words that never carry a concept by themselves.
const STOP = new Set(
  'a an and are as at be by for from in into is of on or the to with within via its their our we using use used based toward towards'.split(' '),
)
const GENERIC = new Set(
  [
    'activity', 'advance', 'analysis', 'application', 'approach', 'aspect', 'assessment', 'development', 'effect', 'evaluation',
    'framework', 'impact', 'investigation', 'issue', 'management', 'method', 'methodology', 'model', 'modeling', 'modelling',
    'new', 'novel', 'outcome', 'performance', 'perspective', 'practice', 'problem', 'process', 'recent', 'research', 'review',
    'role', 'science', 'strategy', 'strategic', 'studies', 'study', 'system', 'technique', 'technology', 'theory', 'tool',
    'trend', 'understanding', 'work', 'general', 'various', 'related', 'other', 'topic', 'field', 'area', 'interest',
  ].map((w) => stem(w)),
)

/** Light stemmer so plurals and possessives meet: peptides -> peptide, studies -> study, crohn's -> crohn. */
export function stem(word) {
  let w = word.toLowerCase().replace(/['’]s$/, '').replace(/['’]/g, '')
  if (w.length <= 3) return w
  if (w.endsWith('ies') && w.length > 4) return `${w.slice(0, -3)}y`
  if (w.endsWith('sses')) return w.slice(0, -2)
  if (/(xes|ches|shes)$/.test(w)) return w.slice(0, -2)
  if (w.endsWith('s') && !/(ss|us|is|ous)$/.test(w)) return w.slice(0, -1)
  return w
}

/** Significant stemmed words of a text, in order. */
export function conceptTokens(text) {
  const words =
    String(text ?? '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .match(/[a-z0-9]+(?:['’][a-z]+)?/g) ?? []
  return words.map(stem).filter((w) => w && !STOP.has(w))
}

const significant = (tokens) => tokens.filter((t) => !GENERIC.has(t))

// Synonyms and abbreviations OpenAlex labels don't spell out. `terms` are interchangeable;
// `narrower` are kinds of the concept (matched slightly lower, and not the other way round).
export const SYNONYM_GROUPS = [
  {
    terms: ['gastrointestinal', 'gi', 'gi tract', 'digestive', 'digestive system', 'gut', 'intestinal', 'intestine', 'bowel', 'gastroenterology', 'enteric', 'alimentary'],
    narrower: ['colorectal', 'colon', 'colonic', 'gastric', 'stomach', 'esophageal', 'oesophageal', 'duodenal', 'ileal', 'inflammatory bowel disease', 'ibd', 'crohn', 'colitis', 'celiac', 'coeliac', 'irritable bowel', 'microbiota', 'microbiome'],
  },
  { terms: ['inflammatory bowel disease', 'ibd'], narrower: ['crohn', 'ulcerative colitis'] },
  { terms: ['irritable bowel syndrome', 'ibs'] },
  { terms: ['microbiome', 'microbiota', 'gut flora', 'gut bacteria'] },
  { terms: ['peptide', 'polypeptide', 'oligopeptide'], narrower: ['peptidomimetic', 'cyclic peptide', 'antimicrobial peptide', 'glp-1', 'glp 1', 'insulin'] },
  { terms: ['protein', 'proteomic', 'proteome'] },
  { terms: ['antibody', 'antibodies', 'immunoglobulin', 'monoclonal antibody', 'mab'] },
  { terms: ['cancer', 'tumor', 'tumour', 'oncology', 'neoplasm', 'carcinoma', 'malignancy'], narrower: ['leukemia', 'lymphoma', 'melanoma', 'glioma', 'sarcoma', 'metastasis'] },
  { terms: ['heart', 'cardiac', 'cardiovascular', 'cardiology', 'coronary'], narrower: ['heart failure', 'atrial fibrillation', 'myocardial', 'arrhythmia'] },
  { terms: ['brain', 'neural', 'neuro', 'neuroscience', 'neuronal', 'cerebral'], narrower: ['cortex', 'hippocampus', 'neuron'] },
  { terms: ['kidney', 'renal', 'nephrology'] },
  { terms: ['liver', 'hepatic', 'hepatology'], narrower: ['hepatitis', 'cirrhosis', 'fatty liver', 'nafld', 'masld'] },
  { terms: ['lung', 'pulmonary', 'respiratory'], narrower: ['asthma', 'copd'] },
  { terms: ['skin', 'dermatology', 'dermal', 'cutaneous'] },
  { terms: ['eye', 'ocular', 'ophthalmology', 'retina', 'retinal'] },
  { terms: ['bone', 'skeletal', 'orthopedic', 'orthopaedic', 'osteo'] },
  { terms: ['diabetes', 'diabetic', 'insulin resistance', 'glycemic'] },
  { terms: ['obesity', 'adiposity', 'overweight'] },
  { terms: ['alzheimer', 'dementia', 'neurodegeneration', 'neurodegenerative'] },
  { terms: ['parkinson', 'parkinsonism'] },
  { terms: ['stroke', 'cerebrovascular'] },
  { terms: ['hiv', 'aids', 'human immunodeficiency virus'] },
  { terms: ['tuberculosis', 'tb', 'mycobacterium'] },
  { terms: ['malaria', 'plasmodium'] },
  { terms: ['covid', 'covid-19', 'sars-cov-2', 'coronavirus'] },
  { terms: ['infection', 'infectious disease', 'pathogen'] },
  { terms: ['vaccine', 'vaccination', 'immunization'] },
  { terms: ['immune', 'immunology', 'immunity', 'immunological'], narrower: ['t cell', 'b cell', 'macrophage', 'cytokine', 'inflammation'] },
  { terms: ['antibiotic', 'antimicrobial', 'antibacterial'], narrower: ['antimicrobial resistance', 'amr'] },
  { terms: ['drug delivery', 'drug carrier', 'controlled release'] },
  { terms: ['drug discovery', 'drug design', 'medicinal chemistry'] },
  { terms: ['nanoparticle', 'nanoparticles', 'nanomaterial', 'nanotechnology', 'nanoscale'] },
  { terms: ['gene editing', 'genome editing', 'crispr', 'cas9'] },
  { terms: ['gene therapy', 'viral vector', 'aav'] },
  { terms: ['rna', 'mrna', 'messenger rna'], narrower: ['microrna', 'mirna', 'lncrna', 'sirna'] },
  { terms: ['genomics', 'genome', 'genomic', 'sequencing'] },
  { terms: ['stem cell', 'stem cells', 'pluripotent', 'ipsc'] },
  { terms: ['mental health', 'psychiatry', 'psychiatric'], narrower: ['depression', 'anxiety', 'schizophrenia', 'bipolar'] },
  { terms: ['pain', 'analgesia', 'nociception'] },
  { terms: ['aging', 'ageing', 'longevity', 'senescence'] },
  { terms: ['machine learning', 'ml', 'statistical learning'], narrower: ['deep learning', 'neural network', 'reinforcement learning'] },
  { terms: ['deep learning', 'neural network', 'neural networks', 'deep neural network'] },
  { terms: ['artificial intelligence', 'ai'], narrower: ['machine learning', 'deep learning'] },
  { terms: ['natural language processing', 'nlp', 'computational linguistics', 'language model'], narrower: ['large language model', 'llm'] },
  { terms: ['large language model', 'llm', 'llms', 'gpt', 'transformer'] },
  { terms: ['computer vision', 'cv', 'image recognition', 'object detection'] },
  { terms: ['reinforcement learning', 'rl'] },
  { terms: ['graph neural network', 'gnn', 'graph learning'] },
  { terms: ['robot', 'robotics', 'robotic'] },
  { terms: ['quantum computing', 'quantum computer', 'qubit', 'quantum information'] },
  { terms: ['blockchain', 'distributed ledger', 'cryptocurrency'] },
  { terms: ['cybersecurity', 'security', 'cryptography', 'privacy'] },
  { terms: ['battery', 'batteries', 'lithium-ion', 'li-ion', 'electrochemical energy storage'] },
  { terms: ['solar', 'photovoltaic', 'pv', 'solar cell'], narrower: ['perovskite solar'] },
  { terms: ['climate', 'climate change', 'global warming'] },
  { terms: ['renewable energy', 'clean energy', 'sustainable energy'] },
  { terms: ['hydrogen', 'fuel cell', 'electrolysis'] },
  { terms: ['carbon capture', 'co2 capture', 'ccs', 'carbon sequestration'] },
  { terms: ['water treatment', 'wastewater', 'desalination'] },
  { terms: ['catalysis', 'catalyst', 'catalytic'], narrower: ['electrocatalysis', 'photocatalysis'] },
  { terms: ['polymer', 'polymers', 'macromolecule'] },
  { terms: ['semiconductor', 'semiconductors', 'transistor'] },
  { terms: ['2d material', 'graphene', 'two-dimensional material'] },
  { terms: ['economics', 'economic', 'econometrics'] },
  { terms: ['public health', 'epidemiology', 'population health'] },
  { terms: ['education', 'learning sciences', 'pedagogy'] },
]

let synonymIndex = null
function synonymsOf(phrase) {
  if (!synonymIndex) {
    synonymIndex = new Map()
    const add = (key, term, weight) => {
      const list = synonymIndex.get(key) ?? []
      list.push([term, weight])
      synonymIndex.set(key, list)
    }
    for (const group of SYNONYM_GROUPS) {
      const terms = group.terms.map((t) => conceptTokens(t).join(' '))
      const narrower = (group.narrower ?? []).map((t) => conceptTokens(t).join(' '))
      for (const key of terms) {
        for (const t of terms) if (t !== key) add(key, t, 0.9)
        for (const t of narrower) add(key, t, 0.75)
      }
    }
  }
  return synonymIndex.get(phrase) ?? []
}

/**
 * "gastrointestinal + peptide", "GI and peptides", "cancer, immunology" -> ['gastrointestinal', 'peptide']...
 * Each part is one concept (ANDed); "a / b" or "a or b" inside a part are alternatives of one concept.
 */
export function parseConcepts(input) {
  return String(input ?? '')
    .split(/\s*(?:\+|&|,|;|\band\b)\s*/i)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 1 && significant(conceptTokens(s)).length > 0)
}

/** Why a concept was ignored, or null: it has no specific word ("strategy", "the analysis"). */
export function conceptProblem(text) {
  const tokens = conceptTokens(text)
  if (!tokens.length) return 'No words to match.'
  if (!significant(tokens).length) return `“${text}” is too general to match on. Try a specific topic.`
  return null
}

// Tag text -> stemmed tokens (cached; the vocabulary is shared across matchers).
const tokenCache = new Map()
function tokensOf(text) {
  let t = tokenCache.get(text)
  if (!t) {
    t = new Set(conceptTokens(text))
    if (tokenCache.size > 200_000) tokenCache.clear()
    tokenCache.set(text, t)
  }
  return t
}

// Every word of `needle` is in `hay`; words of 5+ letters may also be a prefix ("gastro" -> "gastrointestinal").
function phraseIn(needle, hay) {
  let exact = true
  for (const w of needle) {
    if (hay.has(w)) continue
    if (w.length < 5) return 0
    let found = false
    for (const h of hay) {
      if (h.length > w.length && h.startsWith(w)) {
        found = true
        break
      }
    }
    if (!found) return 0
    exact = false
  }
  return exact ? 1 : 0.85
}

/** One concept -> its alternatives as [{ tokens, weight, label }], the concept itself first. */
export function conceptAlternatives(text) {
  const out = []
  const seen = new Set()
  const add = (phrase, weight) => {
    const tokens = significant(conceptTokens(phrase))
    const key = tokens.join(' ')
    if (!tokens.length || seen.has(key)) return
    seen.add(key)
    out.push({ tokens, weight, label: phrase })
  }
  for (const part of String(text).split(/\s*(?:\/|\bor\b)\s*/i)) {
    if (!part.trim()) continue
    add(part, 1)
    const key = conceptTokens(part).join(' ')
    const sigKey = significant(conceptTokens(part)).join(' ')
    for (const [term, w] of [...synonymsOf(key), ...(sigKey !== key ? synonymsOf(sigKey) : [])]) add(term, w)
    // Two-word concepts also try their synonyms word by word: "gi disorders" -> "gastrointestinal disorder".
    const words = conceptTokens(part)
    words.forEach((word, i) => {
      for (const [term, w] of synonymsOf(word)) add([...words.slice(0, i), term, ...words.slice(i + 1)].join(' '), w * 0.95)
    })
  }
  return out
}

/**
 * Tag weights for one concept.
 * vocab: { tags: [names], counts: [people per tag], total } (tags.json; may be empty)
 * synonyms: Map tag name -> { subfield, keywords } (tag_synonyms.json; optional)
 * domains: research-area names (for rows without tags)
 * -> { label, tags: Map lower-case tag -> { weight, via }, domains: Map lower-case domain -> weight }
 */
export function buildConceptMatcher(text, { vocab = null, synonyms = null, domains = [] } = {}) {
  const alternatives = conceptAlternatives(text)
  const names = vocab?.tags ?? []
  const counts = vocab?.counts ?? []
  const total = Math.max(vocab?.total ?? 0, counts[0] ?? 0, 1)
  const tags = new Map()
  const match = (name, i) => {
    let best = 0
    let via = null
    const nameTokens = tokensOf(name)
    const info = synonyms?.get(name)
    for (const alt of alternatives) {
      let w = phraseIn(alt.tokens, nameTokens) * alt.weight
      let how = alt.weight === 1 ? null : alt.label
      if (w < 0.8 * alt.weight && info) {
        for (const kw of info.keywords ?? []) {
          const k = phraseIn(alt.tokens, tokensOf(kw)) * alt.weight * 0.8
          if (k > w) {
            w = k
            how = kw
          }
        }
        if (info.subfield) {
          const s = phraseIn(alt.tokens, tokensOf(info.subfield)) * alt.weight * 0.6
          if (s > w) {
            w = s
            how = info.subfield
          }
        }
      }
      if (w > best) {
        best = w
        via = how
      }
    }
    if (best > 0) tags.set(name.toLowerCase(), { weight: best * rarity(counts[i], total), via })
  }
  names.forEach(match)
  const domainWeights = new Map()
  for (const d of domains) {
    let best = 0
    for (const alt of alternatives) best = Math.max(best, phraseIn(alt.tokens, tokensOf(d)) * alt.weight)
    if (best > 0) domainWeights.set(d.toLowerCase(), best)
  }
  return { label: text, alternatives, tags, domains: domainWeights }
}

/** 1 for a rare tag down to 0.5 for one that half the database or more carries. */
export function rarity(count, total) {
  if (!count || !total) return 1
  const share = count / total
  return share >= 0.5 ? 0.5 : 1 - share
}

// A person's first tag is their main topic; later ones count progressively less.
const positionStrength = (i) => 1 / (1 + 0.15 * i)

/**
 * How well one row fits each concept.
 * -> { score 0-1 (mean over concepts), matched: concepts with a hit, hits: [{ concept, tag, via } | null] }
 */
export function scoreConcepts(row, matchers) {
  let sum = 0
  let matched = 0
  const hits = matchers.map((m) => {
    let best = 0
    let hit = null
    ;(row.tags ?? []).forEach((tag, i) => {
      const t = m.tags.get(String(tag).toLowerCase())
      if (!t) return
      const s = t.weight * positionStrength(i)
      if (s > best) {
        best = s
        hit = { concept: m.label, tag, via: t.via }
      }
    })
    if (!row.tags?.length) {
      // No tags yet (older data): research areas, then the title.
      ;(row.domains ?? []).forEach((d, i) => {
        const w = m.domains.get(String(d).toLowerCase())
        if (w && w * 0.6 * positionStrength(i) > best) {
          best = w * 0.6 * positionStrength(i)
          hit = { concept: m.label, tag: d, via: null }
        }
      })
      if (!best && row.title) {
        const titleTokens = tokensOf(row.title)
        const w = Math.max(0, ...m.alternatives.map((a) => phraseIn(a.tokens, titleTokens) * a.weight))
        if (w) {
          best = w * 0.4
          hit = { concept: m.label, tag: row.title, via: 'title' }
        }
      }
    }
    if (best > 0) matched++
    sum += best
    return hit
  })
  return { score: matchers.length ? sum / matchers.length : 0, matched, hits }
}

/**
 * A visitor's profile mapped onto the tag vocabulary: tags whose specific words all appear in
 * the profile (its interests count double), rarer tags first. Generic words alone never
 * produce a tag. -> [{ tag, weight }] best first, at most `limit`.
 */
export function profileTags(profile, { vocab = null, synonyms = null, limit = 12 } = {}) {
  const names = vocab?.tags ?? []
  if (!names.length) return []
  const total = Math.max(vocab.total ?? 0, vocab.counts?.[0] ?? 0, 1)
  const interestText = (profile?.interests ?? []).join(' . ')
  const interestTokens = new Set(significant(conceptTokens(interestText)))
  const textTokens = new Set(significant(conceptTokens(`${profile?.summary ?? ''} ${profile?.text ?? ''}`)))
  if (!interestTokens.size && !textTokens.size) return []
  const scored = []
  names.forEach((name, i) => {
    const share = (vocab.counts?.[i] ?? 0) / total
    if (share > 0.2) return // too common to tell people apart
    const candidates = [name, ...(synonyms?.get(name)?.keywords ?? [])]
    let best = 0
    for (const [n, text] of candidates.entries()) {
      const tokens = significant(conceptTokens(text))
      if (!tokens.length) continue
      const factor = n === 0 ? 1 : 0.7
      if (tokens.every((t) => interestTokens.has(t))) best = Math.max(best, 2 * factor)
      else if (tokens.every((t) => textTokens.has(t) || interestTokens.has(t))) best = Math.max(best, factor * Math.min(1, 0.5 + 0.25 * tokens.length))
    }
    if (best) scored.push({ tag: name, weight: best * rarity(vocab.counts?.[i], total) })
  })
  return scored.sort((a, b) => b.weight - a.weight || a.tag.localeCompare(b.tag)).slice(0, limit)
}

/** Overlap of a row's tags with profile tags, 0-1. */
export function profileOverlap(row, tags) {
  if (!tags.length || !row.tags?.length) return 0
  const weights = new Map(tags.map((t) => [t.tag.toLowerCase(), t.weight]))
  const max = Math.max(...tags.map((t) => t.weight))
  let sum = 0
  row.tags.forEach((tag, i) => {
    const w = weights.get(String(tag).toLowerCase())
    if (w) sum += (w / max) * positionStrength(i)
  })
  return Math.min(1, sum / 2)
}
