import { MAX_DOCUMENT_CHARS } from './config.js'

// Prompts and output parsing for the Qwen model. Kept free of model code so
// it can be unit tested in Node.

const MAX_INTERESTS = 15

export const EMPTY_PROFILE = Object.freeze({ interests: [], summary: '' })

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
// interests are unioned in order.
export function mergeProfiles(...profiles) {
  const interests = dedupeInterests(profiles.flatMap((p) => p?.interests ?? []))
  const summary = [...profiles].reverse().find((p) => p?.summary)?.summary ?? ''
  return { interests, summary }
}
