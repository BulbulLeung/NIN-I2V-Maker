import { basename } from 'path'

/** Parse `_seed123` / `-seed123` / `.seed123` from a video filename. */
export function parseSeedFromVideoName(name: string): number | null {
  const m = basename(name).match(/(?:^|[_\-.])seed(\d+)(?:[_\-.]|\.|$)/i)
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) ? n : null
}
