import { basename } from 'path'

/** Parse seed from a video filename (legacy `_seed123` or `METHOD_date_seed`). */
export function parseSeedFromVideoName(name: string): number | null {
  const base = basename(name)
  const marked = base.match(/(?:^|[_\-.])seed(\d+)(?:[_\-.]|\.|$)/i)
  if (marked) {
    const n = Number(marked[1])
    return Number.isFinite(n) ? n : null
  }
  // Strip trailing _upscale before extension so upscaled outputs keep source seed.
  const forMethod = base.replace(/_upscale(?=\.[^.]+$)/i, '')
  // I2V_20260803_011600Z_12345.mp4 → trailing numeric segment
  const methodTail = forMethod.match(/^(?:I2V|FLF2V|LOOP)_.+_(\d+)\.[^.]+$/i)
  if (methodTail) {
    const n = Number(methodTail[1])
    return Number.isFinite(n) ? n : null
  }
  return null
}
