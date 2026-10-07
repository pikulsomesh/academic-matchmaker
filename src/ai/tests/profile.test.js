import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildChatMessages,
  buildExtractionMessages,
  dedupeInterests,
  mergeProfiles,
  parseModelProfile,
  QUICK_TEXT_CHARS,
  quickProfile,
  topicsFromText,
} from '../profile.js'

test('parses fenced JSON with surrounding prose', () => {
  const out = 'Sure! Here you go:\n```json\n{"interests": ["Graph Neural Networks", "battery materials", "graph neural networks"], "summary": "ML for energy materials."}\n```'
  assert.deepEqual(parseModelProfile(out), {
    interests: ['Graph Neural Networks', 'battery materials'],
    summary: 'ML for energy materials.',
    reply: '',
  })
})

test('handles braces inside strings and a comma-separated interests string', () => {
  const out = '{"interests": "density functional theory, catalysis", "summary": "Uses {DFT}", "reply": "Added two."}'
  assert.deepEqual(parseModelProfile(out), {
    interests: ['density functional theory', 'catalysis'],
    summary: 'Uses {DFT}',
    reply: 'Added two.',
  })
})

test('falls back to splitting text when there is no JSON', () => {
  assert.deepEqual(parseModelProfile('- reinforcement learning\n- robotics\n- 3. computer vision'), {
    interests: ['reinforcement learning', 'robotics', 'computer vision'],
    summary: '',
    reply: '',
  })
})

test('topicsFromText splits a chat message into topics', () => {
  assert.deepEqual(topicsFromText("I'm also interested in protein design and single-cell genomics"), [
    'protein design',
    'single-cell genomics',
  ])
})

test('dedupeInterests drops empties, duplicates and over-long items', () => {
  assert.deepEqual(dedupeInterests(['  NLP ', 'nlp', '', 'x'.repeat(90), '"Robotics"']), ['NLP', 'Robotics'])
})

test('mergeProfiles unions interests and keeps the latest summary', () => {
  const merged = mergeProfiles(
    { interests: ['A', 'B'], summary: 'first' },
    { interests: ['b', 'C'], summary: '' },
    { interests: [], summary: 'last' },
  )
  assert.deepEqual(merged, { interests: ['A', 'B', 'C'], summary: 'last', text: '' })
})

test('prompts truncate documents and carry the current profile', () => {
  const extraction = buildExtractionMessages('word '.repeat(5000))
  assert.equal(extraction[0].role, 'system')
  assert.ok(extraction[1].content.length < 6100)
  const chat = buildChatMessages({ interests: ['NLP'], summary: 's' }, ' add vision ')
  assert.match(chat[1].content, /"interests":\["NLP"\]/)
  assert.match(chat[1].content, /Message:\nadd vision$/)
})

test('quickProfile takes interests from a listed section and keeps contact details out', () => {
  const resume = `Jane Doe
jane@uni.edu | +1 (555) 123-4567 | https://janedoe.dev
Research Interests
- graph neural networks
- catalyst discovery
- density functional theory
Education
PhD in Chemistry, Somewhere University`
  const { interests, text } = quickProfile(resume)
  assert.deepEqual(interests, ['graph neural networks', 'catalyst discovery', 'density functional theory'])
  assert.match(text, /graph neural networks/)
  assert.doesNotMatch(text, /jane@uni\.edu|555|janedoe\.dev/)
})

test('quickProfile uses a prose summary section and leaves interests empty', () => {
  const resume = `Summary:
I study how single-cell RNA sequencing can reveal tumour heterogeneity and resistance to therapy.
Experience
Research assistant, Lab of Cancer Biology`
  const { interests, text } = quickProfile(resume)
  assert.deepEqual(interests, [])
  assert.match(text, /^I study how single-cell/)
  assert.doesNotMatch(text, /Research assistant/)
})

test('quickProfile without headings keeps long lines and caps the length', () => {
  const lines = ['Jane Doe', 'jane@uni.edu']
  for (let i = 0; i < 40; i++) lines.push(`Learning transferable representations for protein design, paper number ${i}`)
  const { interests, text } = quickProfile(lines.join('\n'))
  assert.deepEqual(interests, [])
  assert.ok(text.length <= QUICK_TEXT_CHARS)
  assert.match(text, /^Learning transferable/)
})

test('quickProfile is empty for text with nothing research-like', () => {
  assert.deepEqual(quickProfile('Jane Doe\njane@uni.edu\n555 123 4567'), { interests: [], text: '' })
})
