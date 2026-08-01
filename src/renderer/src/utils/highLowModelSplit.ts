export interface ModelFileRef {
  name: string
  path: string
}

type Side = 'high' | 'low' | 'none'

/** Strip last extension segment (e.g. `.safetensors`). */
function stemOf(filename: string): string {
  const base = filename.replace(/^.*[/\\]/, '')
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(0, dot) : base
}

/**
 * Delimited markers (`_`, `-`, `.`, whitespace). Longer forms first.
 * Also camelCase High/Low/HighNoise/LowNoise and trailing H/L after alnum
 * (e.g. i2vHigh, snatchkissHighV11, Fp8H).
 */
const DELIM_HIGH = [
  /(?:^|[_\-.\s])high_noise(?=[_\-.\s]|$)/i,
  /(?:^|[_\-.\s])high(?=[_\-.\s]|$)/i,
  /(?:^|[_\-.\s])h(?=[_\-.\s]|$)/i
] as const

const DELIM_LOW = [
  /(?:^|[_\-.\s])low_noise(?=[_\-.\s]|$)/i,
  /(?:^|[_\-.\s])low(?=[_\-.\s]|$)/i,
  /(?:^|[_\-.\s])l(?=[_\-.\s]|$)/i
] as const

/** camelCase: …High / …HighNoise / …Low / …LowNoise */
const CAMEL_HIGH = /(?:(?<=[a-z0-9])|^)High(?:Noise)?(?=[A-Z0-9_\-.\s]|$)/
const CAMEL_LOW = /(?:(?<=[a-z0-9])|^)Low(?:Noise)?(?=[A-Z0-9_\-.\s]|$)/

/** Trailing single H/L glued to previous alnum: Fp8H, FP8L */
const TRAIL_H = /(?<=[A-Za-z0-9])H$/
const TRAIL_L = /(?<=[A-Za-z0-9])L$/

/** Case-insensitive substring fallback: any "high" / "low" text. */
const SUBSTR_HIGH = /high/i
const SUBSTR_LOW = /low/i

function detectSide(stem: string): Side {
  for (const p of DELIM_HIGH) {
    if (p.test(stem)) return 'high'
  }
  for (const p of DELIM_LOW) {
    if (p.test(stem)) return 'low'
  }
  if (CAMEL_HIGH.test(stem) || TRAIL_H.test(stem)) return 'high'
  if (CAMEL_LOW.test(stem) || TRAIL_L.test(stem)) return 'low'
  // Force split on any High/Low text (e.g. embedded in other tokens)
  const hasHigh = SUBSTR_HIGH.test(stem)
  const hasLow = SUBSTR_LOW.test(stem)
  if (hasHigh && !hasLow) return 'high'
  if (hasLow && !hasHigh) return 'low'
  return 'none'
}

/**
 * Split model files into High / Low dropdown lists.
 *
 * - Any file with High marker → high list only
 * - Any file with Low marker → low list only
 * - No High/Low text → both lists
 * - Original order is preserved within each list.
 */
export function splitModelsByHighLow<T extends ModelFileRef>(models: T[]): {
  high: T[]
  low: T[]
} {
  const analyzed = models.map((m) => ({
    m,
    side: detectSide(stemOf(m.name))
  }))

  const high: T[] = []
  const low: T[] = []
  for (const a of analyzed) {
    if (a.side === 'high') {
      high.push(a.m)
    } else if (a.side === 'low') {
      low.push(a.m)
    } else {
      high.push(a.m)
      low.push(a.m)
    }
  }
  return { high, low }
}
