import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { cosineSimilarity, decodeEmbeddingIndex, facultyEmbeddingText, profileEmbeddingText, rankByCosine } from '../vectors.js'

const DIM = 384

function unit(i) {
  const v = new Float32Array(DIM)
  v[i] = 1
  return v
}

function indexJson(rows, dtype) {
  const flat = new Float32Array(rows.length * DIM)
  rows.forEach((r, i) => flat.set(r, i * DIM))
  const bytes = dtype === 'int8' ? Int8Array.from(flat, (x) => Math.round(x * 127)) : flat
  return {
    model: 'Xenova/all-MiniLM-L6-v2',
    dim: DIM,
    dtype,
    ids: rows.map((_, i) => `F${i}`),
    data: Buffer.from(bytes.buffer).toString('base64'),
  }
}

test('faculty text follows the shared recipe', () => {
  const [sample] = JSON.parse(readFileSync(new URL('../../../public/data/faculty_index.json', import.meta.url)))
  assert.equal(
    facultyEmbeddingText(sample),
    'Associate Professor of Materials & Computer Science. Research areas: Artificial Intelligence, Materials Science. Recent work: Sample: Autonomous Discovery of Battery Electrolytes.',
  )
  assert.equal(facultyEmbeddingText({ primary_domain: 'Physics' }), 'Research areas: Physics.')
})

test('profile text', () => {
  assert.equal(profileEmbeddingText({ interests: ['A', 'B'], summary: 'S.' }), 'Research areas: A, B. S.')
  assert.equal(profileEmbeddingText({ interests: [], summary: '' }), '')
})

for (const dtype of ['float32', 'int8']) {
  test(`decodes ${dtype} index and ranks by cosine`, () => {
    const mixed = new Float32Array(DIM)
    mixed[0] = 0.6
    mixed[1] = 0.8
    const index = decodeEmbeddingIndex(indexJson([unit(0), unit(1), mixed], dtype))
    assert.deepEqual(index.ids, ['F0', 'F1', 'F2'])

    const query = new Float32Array(DIM)
    query[1] = 3 // unnormalized on purpose
    const ranked = rankByCosine(query, index)
    assert.deepEqual(ranked.map((r) => r.id), ['F1', 'F2', 'F0'])
    assert.ok(Math.abs(ranked[0].score - 1) < 1e-2)
    assert.ok(Math.abs(ranked[1].score - 0.8) < 1e-2)
    assert.equal(rankByCosine(query, index, 1).length, 1)
  })
}

test('rejects mismatched model, dim or length', () => {
  assert.throws(() => decodeEmbeddingIndex({ ...indexJson([unit(0)], 'float32'), model: 'other' }), /expected Xenova/)
  assert.throws(() => decodeEmbeddingIndex({ ...indexJson([unit(0)], 'float32'), dim: 768 }), /384-dim/)
  assert.throws(() => decodeEmbeddingIndex({ ...indexJson([unit(0)], 'float32'), ids: ['a', 'b'] }), /expected 768/)
})

test('cosineSimilarity', () => {
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0)
  assert.ok(Math.abs(cosineSimilarity([1, 1], [2, 2]) - 1) < 1e-9)
  assert.equal(cosineSimilarity([0, 0], [1, 1]), 0)
})
