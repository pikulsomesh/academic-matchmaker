// Turns an uploaded file into plain text for the Qwen extractor. Heavy
// libraries (pdf.js, Tesseract) load only when a file of that type arrives.

const MAX_PDF_PAGES = 8

async function pdfText(file) {
  const pdfjs = await import('pdfjs-dist')
  const { default: workerSrc } = await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
  pdfjs.GlobalWorkerOptions.workerSrc = workerSrc

  const loading = pdfjs.getDocument({ data: await file.arrayBuffer() })
  try {
    const doc = await loading.promise
    const pages = []
    for (let n = 1; n <= Math.min(doc.numPages, MAX_PDF_PAGES); n++) {
      const content = await (await doc.getPage(n)).getTextContent()
      pages.push(content.items.map((item) => item.str ?? '').join(' '))
    }
    return pages.join('\n')
  } finally {
    await loading.destroy()
  }
}

// OCR for Google Scholar or LinkedIn screenshots. Qwen2.5-0.5B is text-only,
// so images are read with Tesseract first.
async function imageText(file, onProgress) {
  const { createWorker } = await import('tesseract.js')
  const worker = await createWorker('eng', 1, {
    logger: (m) => onProgress?.({ stage: 'ocr', status: m.status, progress: m.progress }),
  })
  try {
    const { data } = await worker.recognize(file)
    return data.text
  } finally {
    await worker.terminate()
  }
}

function htmlText(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  doc.querySelectorAll('script, style, noscript').forEach((el) => el.remove())
  return doc.body?.textContent ?? ''
}

export function documentKind(file) {
  const name = file.name?.toLowerCase() ?? ''
  if (file.type === 'application/pdf' || name.endsWith('.pdf')) return 'pdf'
  if (file.type.startsWith('image/')) return 'image'
  if (file.type === 'text/html' || /\.html?$/.test(name)) return 'html'
  if (file.type.startsWith('text/') || /\.(txt|md|json|csv)$/.test(name)) return 'text'
  return null
}

export async function extractDocumentText(file, onProgress) {
  switch (documentKind(file)) {
    case 'pdf':
      return pdfText(file)
    case 'image':
      return imageText(file, onProgress)
    case 'html':
      return htmlText(await file.text())
    case 'text':
      return file.text()
    default:
      throw new Error(`Unsupported file type: ${file.name}. Upload a PDF, image, HTML or text file.`)
  }
}
