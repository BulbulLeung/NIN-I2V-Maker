import { createRequire } from 'module'
import { existsSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'

const requireFromMain = createRequire(__filename)

function unpackAsarPath(p: string): string {
  if (p.includes('app.asar')) {
    return p.replace('app.asar', 'app.asar.unpacked')
  }
  return p
}

/** Resolve ffmpeg binary (ffmpeg-static, resources/bin, or PATH name). */
export function resolveFfmpegPath(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const staticPath = requireFromMain('ffmpeg-static') as string | null
    if (typeof staticPath === 'string' && staticPath.trim()) {
      const candidates = [staticPath, unpackAsarPath(staticPath)]
      for (const c of candidates) {
        if (c && existsSync(c)) return c
      }
    }
  } catch {
    /* ignore */
  }

  try {
    const resBin = join(
      process.resourcesPath || '',
      'bin',
      process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
    )
    if (existsSync(resBin)) return resBin
  } catch {
    /* ignore */
  }

  try {
    const local = join(
      app.getAppPath(),
      'resources',
      'bin',
      process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
    )
    if (existsSync(local)) return local
  } catch {
    /* ignore */
  }

  return process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
}
