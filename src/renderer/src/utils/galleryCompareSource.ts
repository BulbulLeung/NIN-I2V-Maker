import { basenamePath } from '../services/comfyI2v'

export interface GalleryVideoLike {
  path: string
  name: string
}

const COMPARE_SOURCE_STORAGE_KEY = 'nin-i2v.compareSourceByResult.v1'

function stripExt(name: string): string {
  return name.replace(/\.[^.]+$/, '')
}

/** Gallery collision rename uses `Date.now()` (13 digits). Keep shorter seed suffixes. */
function stripGalleryCollision(stem: string): string {
  return stem.replace(/_\d{13,}$/u, '')
}

function stemOf(name: string): string {
  return stripGalleryCollision(stripExt(name))
}

export function normalizeFsPath(path: string): string {
  return path.trim().replace(/\\/g, '/').toLowerCase()
}

export function pathsEqual(a: string, b: string): boolean {
  return normalizeFsPath(a) === normalizeFsPath(b)
}

/** True if name looks like a Face Detailer gallery result. */
export function isFaceResultName(name: string): boolean {
  const base = stripExt(name)
  return /_face$/i.test(stripGalleryCollision(base)) || /_face_\d{13,}$/i.test(base)
}

/** True if name looks like an Upscale gallery result. */
export function isUpscaleResultName(name: string): boolean {
  return /upscale/i.test(name)
}

/**
 * Recover source stem from a Face / Upscale result filename.
 * Handles `stem_face`, `stem_face_<Date.now()>`, `stem_upscale`, chains like `stem_face_upscale`.
 */
export function sourceStemFromResultName(
  name: string,
  kind: 'face' | 'upscale'
): string | null {
  let base = stemOf(name)
  if (kind === 'face') {
    if (!/_face$/i.test(base)) return null
    return base.replace(/_face$/i, '')
  }
  if (!/_upscale$/i.test(base)) {
    const m = stripExt(name).match(/^(.*)_upscale(?:_\d{13,})?$/i)
    if (!m) return null
    return stripGalleryCollision(m[1])
  }
  return base.replace(/_upscale$/i, '')
}

function isResultName(name: string, kind: 'face' | 'upscale'): boolean {
  return kind === 'face' ? isFaceResultName(name) : isUpscaleResultName(name)
}

function findListedPath(videos: GalleryVideoLike[], path: string): string | null {
  const hit = videos.find((v) => pathsEqual(v.path, path))
  return hit?.path ?? null
}

/**
 * Resolve the original video path for a Face / Upscale result in the compare viewer.
 * Order: remembered pairing → stem match in gallery → left-panel selection.
 */
export function resolveCompareSourcePath(
  resultPath: string | null,
  videos: GalleryVideoLike[],
  selectedSourcePath: string,
  kind: 'face' | 'upscale',
  rememberedPath?: string | null
): string | null {
  if (!resultPath) return null

  const remembered = (rememberedPath || '').trim()
  if (remembered && !pathsEqual(remembered, resultPath)) {
    const rememberedName = basenamePath(remembered)
    if (!isResultName(rememberedName, kind)) {
      return findListedPath(videos, remembered) || remembered
    }
  }

  const stem = sourceStemFromResultName(basenamePath(resultPath), kind)
  if (stem) {
    const exact = videos.find((v) => {
      if (pathsEqual(v.path, resultPath)) return false
      if (isResultName(v.name, kind)) return false
      return stemOf(v.name) === stem || stripExt(v.name) === stem
    })
    if (exact) return exact.path

    // Prefix match: original stem is a proper prefix of the recovered stem
    // (e.g. result kept extra seed/stamp segments). Do not match longer originals
    // (would map `clip_upscale` → `clip_face`).
    const fuzzy = videos
      .filter((v) => {
        if (pathsEqual(v.path, resultPath)) return false
        if (isResultName(v.name, kind)) return false
        const b = stemOf(v.name)
        return b === stem || stem.startsWith(`${b}_`)
      })
      .sort((a, b) => stemOf(b.name).length - stemOf(a.name).length)
    if (fuzzy[0]) return fuzzy[0].path
  }

  const selected = selectedSourcePath.trim()
  if (
    selected &&
    !pathsEqual(selected, resultPath) &&
    !isResultName(basenamePath(selected), kind)
  ) {
    return findListedPath(videos, selected) || selected
  }
  return null
}

export function loadCompareSourceMap(): Map<string, string> {
  try {
    const raw = localStorage.getItem(COMPARE_SOURCE_STORAGE_KEY)
    if (!raw) return new Map()
    const obj = JSON.parse(raw) as Record<string, string>
    const map = new Map<string, string>()
    for (const [k, v] of Object.entries(obj)) {
      if (typeof k === 'string' && typeof v === 'string' && k && v) map.set(k, v)
    }
    return map
  } catch {
    return new Map()
  }
}

export function rememberCompareSource(
  map: Map<string, string>,
  resultPath: string,
  sourcePath: string
): void {
  const result = resultPath.trim()
  const source = sourcePath.trim()
  if (!result || !source || pathsEqual(result, source)) return
  // Drop stale keys that only differ by slash/case.
  for (const key of [...map.keys()]) {
    if (pathsEqual(key, result)) map.delete(key)
  }
  map.set(result, source)
  try {
    localStorage.setItem(
      COMPARE_SOURCE_STORAGE_KEY,
      JSON.stringify(Object.fromEntries(map))
    )
  } catch {
    // ignore quota / private mode
  }
}

export function forgetCompareSource(map: Map<string, string>, resultPath: string): void {
  const result = resultPath.trim()
  if (!result) return
  for (const key of [...map.keys()]) {
    if (pathsEqual(key, result)) map.delete(key)
  }
  try {
    localStorage.setItem(
      COMPARE_SOURCE_STORAGE_KEY,
      JSON.stringify(Object.fromEntries(map))
    )
  } catch {
    // ignore
  }
}

export function lookupCompareSource(
  map: Map<string, string>,
  resultPath: string | null | undefined
): string | undefined {
  const result = (resultPath || '').trim()
  if (!result) return undefined
  const direct = map.get(result)
  if (direct) return direct
  for (const [key, value] of map) {
    if (pathsEqual(key, result)) return value
  }
  return undefined
}
