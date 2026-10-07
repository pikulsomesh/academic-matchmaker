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

test('int8 shards rank like decoded float indexes, across several shards', async () => {
  const { decodeEmbeddingShard, rankIndexes } = await import('../vectors.js')
  const mixed = (a, b) => {
    const v = new Float32Array(DIM)
    v[a] = 0.8
    v[b] = 0.6
    return v
  }
  const a = indexJson([unit(0), mixed(1, 0)], 'int8')
  const b = indexJson([mixed(0, 2), unit(3)], 'int8')
  b.ids = ['G0', 'G1']
  const shards = [decodeEmbeddingShard(a), decodeEmbeddingShard(b)]
  assert.ok(shards[0].int8 instanceof Int8Array)

  const ranked = rankIndexes(unit(0), shards)
  assert.deepEqual(ranked.map((r) => r.id), ['F0', 'G0', 'F1', 'G1'])
  assert.ok(Math.abs(ranked[0].score - 1) < 1e-6)
  assert.ok(Math.abs(ranked[1].score - 0.8) < 0.01)

  const float = decodeEmbeddingIndex(a)
  const viaFloat = rankByCosine(unit(1), float)
  const viaShard = rankIndexes(unit(1), [shards[0]])
  viaFloat.forEach((r, i) => assert.ok(Math.abs(r.score - viaShard[i].score) < 1e-5))
  assert.equal(rankIndexes(unit(0), shards, 2).length, 2)
})

test('rankIndexes filters to allowed ids and reports each row’s university', async () => {
  const { decodeEmbeddingShard, rankIndexes } = await import('../vectors.js')
  const json = indexJson([unit(0), unit(1), unit(2)], 'int8')
  json.institution_ids = ['I1', 'I2', 'I1']
  const cluster = decodeEmbeddingShard(json)
  const ranked = rankIndexes(unit(2), [cluster], Infinity, new Set(['F0', 'F2']))
  assert.deepEqual(ranked.map((r) => [r.id, r.institutionId]), [['F2', 'I1'], ['F0', 'I1']])
})
