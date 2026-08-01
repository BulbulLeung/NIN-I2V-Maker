import { readFile, writeFile } from 'fs/promises'
import { basename } from 'path'

export interface VideoGalleryMeta {
  seed: number
}

export function videoMetaSidecarPath(videoPath: string): string {
  return `${videoPath}.ninmeta.json`
}

/** Parse `_seed123` / `-seed123` / `.seed123` from a video filename. */
export function parseSeedFromVideoName(name: string): number | null {
  const m = basename(name).match(/(?:^|[_\-.])seed(\d+)(?:[_\-.]|\.|$)/i)
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) ? n : null
}

export async function writeVideoGalleryMeta(
  videoPath: string,
  meta: VideoGalleryMeta
): Promise<void> {
  const payload = {
    seed: Math.floor(meta.seed),
    savedAt: new Date().toISOString()
  }
  await writeFile(videoMetaSidecarPath(videoPath), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
}

export async function readVideoGalleryMeta(videoPath: string): Promise<VideoGalleryMeta | null> {
  try {
    const raw = await readFile(videoMetaSidecarPath(videoPath), 'utf8')
    const parsed = JSON.parse(raw) as { seed?: unknown }
    const seed = typeof parsed.seed === 'number' ? parsed.seed : Number(parsed.seed)
    if (!Number.isFinite(seed)) return null
    return { seed: Math.floor(seed) }
  } catch {
    return null
  }
}

export async function resolveVideoSeed(videoPath: string): Promise<number | null> {
  const fromMeta = await readVideoGalleryMeta(videoPath)
  if (fromMeta) return fromMeta.seed
  return parseSeedFromVideoName(videoPath)
}
