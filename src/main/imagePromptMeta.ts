import { inflateSync } from 'zlib'
import { readFile } from 'fs/promises'
import { extname } from 'path'

/**
 * Extract a positive / generation prompt embedded in image metadata
 * (A1111 PNG parameters, NovelAI Comment JSON, ComfyUI prompt JSON, etc.).
 */

function readU32BE(buf: Buffer, offset: number): number {
  return buf.readUInt32BE(offset)
}

function decodePngTextChunks(buf: Buffer): Record<string, string> {
  const out: Record<string, string> = {}
  if (buf.length < 8) return out
  const sig = buf.subarray(0, 8)
  const pngSig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  if (!sig.equals(pngSig)) return out

  let offset = 8
  while (offset + 12 <= buf.length) {
    const length = readU32BE(buf, offset)
    const type = buf.toString('ascii', offset + 4, offset + 8)
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    if (dataEnd + 4 > buf.length) break
    const data = buf.subarray(dataStart, dataEnd)
    offset = dataEnd + 4

    if (type === 'tEXt') {
      const nul = data.indexOf(0)
      if (nul <= 0) continue
      const key = data.subarray(0, nul).toString('latin1')
      const value = data.subarray(nul + 1).toString('latin1')
      if (key) out[key] = value
    } else if (type === 'iTXt') {
      const nul = data.indexOf(0)
      if (nul <= 0) continue
      const key = data.subarray(0, nul).toString('utf8')
      let p = nul + 1
      if (p + 2 > data.length) continue
      const compressed = data[p]
      p += 2 // compression flag + method
      // language tag
      const langNul = data.indexOf(0, p)
      if (langNul < 0) continue
      p = langNul + 1
      // translated keyword
      const trNul = data.indexOf(0, p)
      if (trNul < 0) continue
      p = trNul + 1
      let textBuf = data.subarray(p)
      try {
        if (compressed === 1) textBuf = inflateSync(textBuf)
        const value = textBuf.toString('utf8')
        if (key) out[key] = value
      } catch {
        /* ignore bad iTXt */
      }
    } else if (type === 'zTXt') {
      const nul = data.indexOf(0)
      if (nul <= 0 || nul + 2 > data.length) continue
      const key = data.subarray(0, nul).toString('latin1')
      const compData = data.subarray(nul + 2)
      try {
        const value = inflateSync(compData).toString('latin1')
        if (key) out[key] = value
      } catch {
        /* ignore */
      }
    } else if (type === 'IEND') {
      break
    }
  }
  return out
}

/** A1111 / Forge: everything before "Negative prompt:" */
export function positiveFromParametersBlock(parameters: string): string | null {
  const raw = parameters.trim()
  if (!raw) return null
  const neg = raw.search(/\nNegative prompt\s*:/i)
  const head = (neg >= 0 ? raw.slice(0, neg) : raw).trim()
  // Drop trailing Steps:/Sampler: metadata lines that sometimes appear without Negative prompt
  const lines = head.split(/\r?\n/)
  const promptLines: string[] = []
  for (const line of lines) {
    if (/^(Steps|Sampler|CFG scale|Seed|Size|Model|Clip skip|Schedule)\s*:/i.test(line.trim())) {
      break
    }
    promptLines.push(line)
  }
  const positive = promptLines.join('\n').trim()
  return positive || null
}

function tryParseJsonPrompt(raw: string): string | null {
  const text = raw.trim()
  if (!text.startsWith('{') && !text.startsWith('[')) return null
  try {
    const obj = JSON.parse(text) as unknown
    if (!obj || typeof obj !== 'object') return null

    // NovelAI / some tools: { prompt: "..." }
    if (!Array.isArray(obj) && typeof (obj as { prompt?: unknown }).prompt === 'string') {
      const p = ((obj as { prompt: string }).prompt || '').trim()
      if (p && !p.startsWith('{')) return p
    }

    // ComfyUI API prompt graph: { "3": { class_type, inputs: { text } }, ... }
    if (!Array.isArray(obj)) {
      const texts: string[] = []
      for (const node of Object.values(obj as Record<string, unknown>)) {
        if (!node || typeof node !== 'object') continue
        const n = node as { class_type?: string; inputs?: Record<string, unknown> }
        const ct = (n.class_type || '').toLowerCase()
        if (!ct.includes('cliptextencode') && !ct.includes('textencode')) continue
        const t = n.inputs?.text
        if (typeof t === 'string' && t.trim()) texts.push(t.trim())
      }
      // Prefer the longest non-empty encode (often positive is richer than negative)
      texts.sort((a, b) => b.length - a.length)
      if (texts[0] && texts[0].length >= 8) return texts[0]
    }
  } catch {
    return null
  }
  return null
}

export function extractPositiveFromMetaMap(meta: Record<string, string>): string | null {
  const keysPreferred = [
    'parameters',
    'Parameters',
    'prompt',
    'Prompt',
    'Comment',
    'comment',
    'Description',
    'description',
    'sd-metadata',
    'workflow'
  ]

  for (const key of keysPreferred) {
    const value = meta[key]
    if (!value || !value.trim()) continue

    if (/^parameters$/i.test(key)) {
      const fromParams = positiveFromParametersBlock(value)
      if (fromParams) return fromParams
    }

    const fromJson = tryParseJsonPrompt(value)
    if (fromJson) return fromJson

    // Plain prompt field
    if (/^prompt$/i.test(key)) {
      const plain = value.trim()
      if (plain && !plain.startsWith('{')) return plain
    }

    // Description / Comment as free text (if not JSON)
    if (/^(comment|description)$/i.test(key)) {
      const plain = value.trim()
      if (plain && !plain.startsWith('{') && plain.length >= 8) {
        const fromParams = positiveFromParametersBlock(plain)
        return fromParams || plain
      }
    }
  }

  // Any remaining text chunk that looks like A1111 parameters
  for (const value of Object.values(meta)) {
    if (!value || !/\nNegative prompt\s*:/i.test(value)) continue
    const fromParams = positiveFromParametersBlock(value)
    if (fromParams) return fromParams
  }

  return null
}

export async function readImagePositivePrompt(imagePath: string): Promise<{
  positive: string | null
  source: string | null
}> {
  const path = (imagePath || '').trim()
  if (!path) return { positive: null, source: null }

  const ext = extname(path).toLowerCase()
  const buf = await readFile(path)

  if (ext === '.png') {
    const meta = decodePngTextChunks(buf)
    const positive = extractPositiveFromMetaMap(meta)
    if (positive) {
      const source =
        Object.keys(meta).find((k) => /parameters|prompt|comment|description|workflow/i.test(k)) ||
        'png'
      return { positive, source }
    }
    return { positive: null, source: null }
  }

  // Non-PNG: no embedded text support yet
  return { positive: null, source: null }
}
