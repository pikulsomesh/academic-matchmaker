import { MAX_DOCUMENT_CHARS } from './config.js'

// Prompts and output parsing for the Qwen model. Kept free of model code so
// it can be unit tested in Node.

const MAX_INTERESTS = 15

// interests and summary come from the user (chat) or a document's own interest list; text is
// research-relevant document text (quickProfile) that is embedded as is.
export const EMPTY_PROFILE = Object.freeze({ interests: [], summary: '', text: '' })

const EXTRACT_SYSTEM = `You read academic CVs, resumes, Google Scholar pages and LinkedIn profiles and list the person's research interests.
Reply with JSON only, no prose, in this shape:
{"interests": ["short topic", "..."], "summary": "one sentence describing their research focus"}
Use 3 to 12 specific research topics (methods, materials, application areas), each 1 to 5 words. Ignore employers, contact details, courses and soft skills.`

const CHAT_SYSTEM = `You help a prospective PhD or post-doc candidate describe their research interests so they can be matched with faculty.
You are given their current interest profile and a new message from them. List the research topics the message adds, and rewrite the summary to cover the whole profile.
Reply with JSON only, no prose, in this shape:
{"interests": ["new topic", "..."], "summary": "one sentence describing their research focus", "reply": "one short friendly sentence confirming what you added"}
Each topic is 1 to 5 words. Use an empty list if the message adds no research topic.`

export function buildExtractionMessages(documentText) {
  const text = documentText.replace(/\s+/g, ' ').trim().slice(0, MAX_DOCUMENT_CHARS)
  return [
    { role: 'system', content: EXTRACT_SYSTEM },
    { role: 'user', content: `Document:\n"""\n${text}\n"""` },
  ]
}

export function buildChatMessages(profile, userText) {
  return [
    { role: 'system', content: CHAT_SYSTEM },
    {
      role: 'user',
      content: `Current profile:\n${JSON.stringify({ interests: profile.interests, summary: profile.summary })}\n\nMessage:\n${userText.trim()}`,
    },
  ]
}

function cleanTopic(topic) {
  return String(topic)
    .replace(/^[\s\-*•\d.)]+/, '')
    .replace(/["'`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function dedupeInterests(list) {
  const seen = new Set()
  const out = []
  for (const raw of list) {
    const topic = cleanTopic(raw)
    const key = topic.toLowerCase()
    if (!topic || topic.length > 80 || seen.has(key)) continue
    seen.add(key)
    out.push(topic)
  }
  return out.slice(0, MAX_INTERESTS)
}

// Pulls the first JSON object out of model output. Small models often wrap it
// in ```json fences or add a sentence before or after.
function findJsonObject(text) {
  const start = text.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inString = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (ch === '\\') i++
      else if (ch === '"') inString = false
    } else if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1))
      } catch {
        return null
      }
    }
  }
  return null
}

// Splits free text like "graph neural networks, battery materials and LLMs"
// into topics. Used when the model reply isn't parseable JSON.
export function topicsFromText(text) {
  return dedupeInterests(
    text
      .split(/[\n,;•]|\band\b|\s-\s/i)
      .map((s) => s.replace(/^(i am |i'm |also |interested in |working on |my research is )+/i, ''))
      .filter((s) => s.trim().split(/\s+/).length <= 6),
  )
}

// --- Quick profile: no language model -------------------------------------------------
//
// A resume or CV is matched by embedding its research-relevant text directly with
// MiniLM, so the first match needs only the small embedding model. quickProfile()
// picks that text: a "Research interests" / "Summary" section when there is one,
// otherwise the longest prose-like lines (publication titles, bullet points) with
// contact details and headings left out.

// MiniLM reads about 256 tokens, roughly this many characters.
export const QUICK_TEXT_CHARS = 1000

const FOCUS_HEADING =
  /^(research\s+(interests?|summary|statement|focus|areas?|overview)|areas?\s+of\s+(research|interest|expertise)|interests?|summary|professional\s+summary|objective|profile|about(\s+me)?|abstract|expertise|keywords?)\s*:?$/i
const LIST_HEADING = /^(research\s+interests?|areas?\s+of\s+(research|interest|expertise)|interests?|expertise|keywords?)\s*:?$/i
const OTHER_HEADING =
  /^(education|experience|employment|work\s+experience|professional\s+experience|publications?|selected\s+publications?|awards?|honou?rs|skills|references|teaching|service|projects?|courses|contact|presentations?|patents?|talks|affiliations?|funding|grants|research\s+experience)\s*:?$/i
const NOISE =
  /(@|https?:\/\/|www\.|linkedin\.com|github\.com|scholar\.google|orcid\.org|curriculum\s+vitae|\bpage\s+\d+|\+?\d[\d\s().-]{8,}\d)/i

const wordCount = (line) => line.split(/\s+/).filter(Boolean).length
const stripBullet = (line) => line.replace(/^[\s\-*•·▪◦‣\d.)]+/, '').trim()

function trimToChars(parts, limit) {
  const out = []
  let used = 0
  for (const part of parts) {
    if (used + part.length > limit && out.length) break
    out.push(part.slice(0, limit - used))
    used += part.length + 1
    if (used >= limit) break
  }
  return out.join(' ')
}

/**
 * Research profile straight from document text, without a language model.
 * -> { interests, text }: interests only when the document lists them under a heading
 * ("Research interests: ..."); text is what MiniLM embeds.
 */
export function quickProfile(text) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)

  let interests = []
  const sectionLines = []
  const start = lines.findIndex((l) => FOCUS_HEADING.test(l.replace(/:$/, '')))
  if (start !== -1) {
    const listed = LIST_HEADING.test(lines[start])
    for (const line of lines.slice(start + 1, start + 13)) {
      if (OTHER_HEADING.test(line) || FOCUS_HEADING.test(line)) break
      if (!NOISE.test(line)) sectionLines.push(stripBullet(line))
    }
    // "Interests: a, b, c" on the heading line itself.
    const inline = lines[start].match(/^[^:]{3,40}:\s*(.+)$/)
    if (inline && !NOISE.test(inline[1])) sectionLines.unshift(inline[1])
    const short = sectionLines.length > 0 && sectionLines.every((l) => wordCount(l) <= 8)
    if (listed && short) interests = topicsFromText(sectionLines.join('\n'))
  }

  const prose = lines
    .map(stripBullet)
    .filter((l) => wordCount(l) >= 4 && !NOISE.test(l) && !FOCUS_HEADING.test(l) && !OTHER_HEADING.test(l))
    // A one-line extraction (PDF without line breaks, OCR): fall back to the start of the text.
    .map((l) => l.slice(0, 400))
  // A real section is the best statement of focus; otherwise fall back to the document's prose.
  const parts = sectionLines.join(' ').length >= 40 ? sectionLines : [...sectionLines, ...prose.filter((l) => !sectionLines.includes(l))]
  return { interests, text: trimToChars(parts, QUICK_TEXT_CHARS) }
}

// Returns { interests, summary, reply } from raw model output.
export function parseModelProfile(output) {
  const obj = findJsonObject(output)
  if (obj && typeof obj === 'object') {
    const interests = Array.isArray(obj.interests)
      ? obj.interests
      : typeof obj.interests === 'string'
        ? obj.interests.split(',')
        : []
    return {
      interests: dedupeInterests(interests),
      summary: typeof obj.summary === 'string' ? obj.summary.trim() : '',
      reply: typeof obj.reply === 'string' ? obj.reply.trim() : '',
    }
  }
  return { interests: topicsFromText(output), summary: '', reply: '' }
}

// Combines profiles from several sources. Later sources win on summary;
// interests are unioned in order and document texts are joined.
export function mergeProfiles(...profiles) {
  const interests = dedupeInterests(profiles.flatMap((p) => p?.interests ?? []))
  const summary = [...profiles].reverse().find((p) => p?.summary)?.summary ?? ''
  const text = [...new Set(profiles.map((p) => p?.text).filter(Boolean))].join(' ')
  return { interests, summary, text }
}
