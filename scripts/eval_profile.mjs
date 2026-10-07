// Bridge for scripts/laureate_eval.py: builds a profile with the site's own code (src/ai) so the eval
// runs the same profile logic the browser does. Prints one JSON object.
//   node scripts/eval_profile.mjs openalex <ORCID iD | OpenAlex author id | author link>
//   node scripts/eval_profile.mjs text <path to a text file>      (what a resume becomes after pdf.js)
import { readFileSync } from 'node:fs'
import { fetchOpenAlexProfile } from '../src/ai/openalexProfile.js'
import { quickProfile } from '../src/ai/profile.js'
import { profileEmbeddingText } from '../src/ai/vectors.js'

const [, , kind, arg] = process.argv

try {
  let profile
  if (kind === 'openalex') profile = await fetchOpenAlexProfile(arg)
  else if (kind === 'text') profile = quickProfile(readFileSync(arg, 'utf8'))
  else throw new Error(`Unknown kind: ${kind}`)
  console.log(JSON.stringify({ ok: true, name: profile.name ?? null, interests: profile.interests ?? [], embedding_text: profileEmbeddingText(profile) }))
} catch (err) {
  console.log(JSON.stringify({ ok: false, error: err?.message ?? String(err) }))
}
