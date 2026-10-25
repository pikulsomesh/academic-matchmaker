import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildConceptMatcher,
  conceptProblem,
  parseConcepts,
  profileOverlap,
  profileTags,
  scoreConcepts,
  stem,
} from '../concepts.js'

const VOCAB = {
  tags: [
    'Inflammatory Bowel Disease',
    'Antimicrobial Peptides and Activities',
    'Colorectal Cancer Treatments',
    'Peptide',
    'Gut microbiota and health',
    'Business Strategy and Innovation',
    'Battery Materials',
    'Helicobacter pylori-related gastroenterology',
  ],
  counts: [40, 30, 50, 20, 60, 10, 80, 5],
  total: 1000,
}
const SYNONYMS = new Map([
  ['Inflammatory Bowel Disease', { subfield: 'Gastroenterology', keywords: ["Crohn's disease", 'Ulcerative colitis'] }],
])
const ctx = { vocab: VOCAB, synonyms: SYNONYMS, domains: ['Gastroenterology', 'Materials Chemistry'] }

const people = {
  ibdPeptide: { id: 'P1', tags: ['Inflammatory Bowel Disease', 'Peptide'] },
  ibdOnly: { id: 'P2', tags: ['Inflammatory Bowel Disease', 'Gut microbiota and health'] },
  amp: { id: 'P3', tags: ['Battery Materials', 'Antimicrobial Peptides and Activities'] },
  business: { id: 'P4', tags: ['Business Strategy and Innovation'] },
  legacy: { id: 'P5', tags: [], domains: ['Gastroenterology'], title: 'Professor of Peptide Chemistry' },
}

test('stemming meets plurals and possessives', () => {
  assert.equal(stem('peptides'), 'peptide')
  assert.equal(stem('studies'), 'study')
  assert.equal(stem("Crohn's"), 'crohn')
  assert.equal(stem('diseases'), 'disease')
  assert.equal(stem('analysis'), 'analysis')
})

test('queries split into ANDed concepts, generic ones are refused', () => {
  assert.deepEqual(parseConcepts('gastrointestinal + peptide'), ['gastrointestinal', 'peptide'])
  assert.deepEqual(parseConcepts('GI and peptides, strategy'), ['GI', 'peptides'])
  assert.match(conceptProblem('strategy'), /too general/)
  assert.equal(conceptProblem('peptide'), null)
})

test('synonyms and abbreviations reach OpenAlex topic names', () => {
  for (const term of ['gastrointestinal', 'GI', 'digestive', 'gut']) {
    const m = buildConceptMatcher(term, ctx)
    assert.ok(m.tags.has('inflammatory bowel disease'), `${term} -> IBD`)
    assert.ok(m.tags.has('colorectal cancer treatments'), `${term} -> colorectal (narrower)`)
    assert.ok(!m.tags.has('battery materials'))
  }
  // Topic keywords and subfields from tag_synonyms.json.
  assert.ok(buildConceptMatcher('Crohn disease', ctx).tags.has('inflammatory bowel disease'))
  assert.ok(buildConceptMatcher('gastroenterology', ctx).tags.has('inflammatory bowel disease'))
  // Plural and prefix forms.
  assert.ok(buildConceptMatcher('peptides', ctx).tags.has('peptide'))
  assert.ok(buildConceptMatcher('gastro', ctx).tags.has('helicobacter pylori-related gastroenterology'))
})

test('a generic word never matches by itself', () => {
  const m = buildConceptMatcher('strategy', ctx)
  assert.equal(m.tags.size, 0)
  const two = buildConceptMatcher('peptide strategy', ctx)
  assert.ok(two.tags.has('peptide') && !two.tags.has('business strategy and innovation'))
})

test('combined concepts rank people who match both first', () => {
  const matchers = ['gastrointestinal', 'peptide'].map((c) => buildConceptMatcher(c, ctx))
  const scored = Object.entries(people).map(([k, row]) => [k, scoreConcepts(row, matchers)])
  const both = scored.filter(([, s]) => s.matched === 2).map(([k]) => k)
  assert.deepEqual(both.sort(), ['ibdPeptide', 'legacy'])
  const byScore = scored.sort((a, b) => b[1].score - a[1].score).map(([k]) => k)
  assert.equal(byScore[0], 'ibdPeptide')
  assert.equal(scored.find(([k]) => k === 'business')[1].matched, 0)
  const hits = scoreConcepts(people.ibdPeptide, matchers).hits
  assert.deepEqual(hits.map((h) => h.tag), ['Inflammatory Bowel Disease', 'Peptide'])
})

test('a resume maps onto specific tags, not generic words', () => {
  const profile = {
    interests: ['peptide therapeutics'],
    text: 'Developed a strategy for oral delivery in inflammatory bowel disease models, with analysis of Crohn disease cohorts.',
  }
  const tags = profileTags(profile, { vocab: VOCAB, synonyms: SYNONYMS }).map((t) => t.tag)
  assert.deepEqual(tags.slice(0, 2).sort(), ['Inflammatory Bowel Disease', 'Peptide'])
  assert.ok(!tags.includes('Business Strategy and Innovation'))
  const weighted = profileTags(profile, { vocab: VOCAB, synonyms: SYNONYMS })
  assert.ok(profileOverlap(people.ibdPeptide, weighted) > profileOverlap(people.ibdOnly, weighted))
  assert.equal(profileOverlap(people.business, weighted), 0)
})
