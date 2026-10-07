// Runs Qwen2.5-0.5B-Instruct and MiniLM off the main thread so the UI stays
// responsive while models download and generate.
//
// Requests:  { id, type: 'load' | 'generate' | 'embed', ... }
// Responses: { id, type: 'result', result } | { id, type: 'error', error }
//            { type: 'progress', model, progress (0-100), loaded, total }
//            { type: 'embed-progress', id, done, total }
//            { type: 'device', model, device, dtype }

import { env, pipeline } from '@huggingface/transformers'
import { CHAT_MODEL, EMBEDDING_MODEL } from './config.js'

env.allowLocalModels = false

const EMBED_BATCH = 32

function progressReporter(model) {
  return (p) => {
    if (p.status === 'progress_total') {
      self.postMessage({ type: 'progress', model, progress: p.progress, loaded: p.loaded, total: p.total })
    } else if (p.status === 'ready') {
      self.postMessage({ type: 'progress', model, progress: 100 })
    }
  }
}

async function webgpuSupport() {
  if (!self.navigator?.gpu) return null
  try {
    const adapter = await self.navigator.gpu.requestAdapter()
    if (!adapter) return null
    return { fp16: adapter.features.has('shader-f16') }
  } catch {
    return null
  }
}

let chatPromise = null
let embedPromise = null

// WebGPU when the browser has it, otherwise WASM on the CPU. A failed WebGPU
// load (driver issues, out of memory) falls back to WASM too.
function loadChat() {
  chatPromise ??= (async () => {
    const gpu = await webgpuSupport()
    const attempts = gpu
      ? [
          { device: 'webgpu', dtype: gpu.fp16 ? 'q4f16' : 'q4' },
          { device: 'wasm', dtype: 'q4' },
        ]
      : [{ device: 'wasm', dtype: 'q4' }]

    let lastError
    for (const { device, dtype } of attempts) {
      try {
        const generator = await pipeline('text-generation', CHAT_MODEL, {
          device,
          dtype,
          progress_callback: progressReporter('chat'),
        })
        self.postMessage({ type: 'device', model: 'chat', device, dtype })
        return generator
      } catch (err) {
        lastError = err
      }
    }
    throw new Error(`Couldn't load the language model (${lastError?.message ?? lastError}).`)
  })()
  chatPromise.catch(() => {
    chatPromise = null
  })
  return chatPromise
}

function loadEmbedder() {
  embedPromise ??= (async () => {
    const extractor = await pipeline('feature-extraction', EMBEDDING_MODEL, {
      device: 'wasm',
      dtype: 'q8',
      progress_callback: progressReporter('embedding'),
    }).catch((err) => {
      throw new Error(`Couldn't load the embedding model (${err?.message ?? err}).`)
    })
    self.postMessage({ type: 'device', model: 'embedding', device: 'wasm', dtype: 'q8' })
    return extractor
  })()
  embedPromise.catch(() => {
    embedPromise = null
  })
  return embedPromise
}

async function generate({ messages, maxNewTokens = 256 }) {
  const generator = await loadChat()
  const output = await generator(messages, {
    max_new_tokens: maxNewTokens,
    do_sample: false,
    repetition_penalty: 1.05,
  })
  return output[0].generated_text.at(-1).content
}

// Returns one Float32Array of texts.length * dim unit vectors, row-major.
async function embed({ texts }, id) {
  const extractor = await loadEmbedder()
  const rows = []
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH)
    const tensor = await extractor(batch, { pooling: 'mean', normalize: true })
    rows.push(tensor.data)
    if (texts.length > EMBED_BATCH) {
      self.postMessage({ type: 'embed-progress', id, done: Math.min(i + EMBED_BATCH, texts.length), total: texts.length })
    }
  }
  const out = new Float32Array(rows.reduce((n, r) => n + r.length, 0))
  let offset = 0
  for (const r of rows) {
    out.set(r, offset)
    offset += r.length
  }
  return out
}

self.addEventListener('message', async ({ data }) => {
  const { id, type } = data
  try {
    let result
    if (type === 'load') {
      await Promise.all([data.models.includes('embedding') && loadEmbedder(), data.models.includes('chat') && loadChat()])
      result = true
    } else if (type === 'generate') {
      result = await generate(data)
    } else if (type === 'embed') {
      result = await embed(data, id)
      self.postMessage({ id, type: 'result', result }, [result.buffer])
      return
    } else {
      throw new Error(`Unknown request: ${type}`)
    }
    self.postMessage({ id, type: 'result', result })
  } catch (err) {
    self.postMessage({ id, type: 'error', error: err?.message ?? String(err) })
  }
})
