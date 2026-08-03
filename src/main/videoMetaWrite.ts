import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { rename, rm } from 'fs/promises'
import { basename, dirname, extname, join } from 'path'
import { resolveFfmpegPath } from './videoFfmpegPath'

const META_PROMPT_KEY = 'nin_prompt'
const META_SEED_KEY = 'nin_seed'
/** Keep prompts from blowing past typical container tag limits. */
const MAX_PROMPT_CHARS = 60_000

export interface VideoUserMeta {
  prompt: string | null
  seed: number | null
}

function runFfmpeg(ffmpeg: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg, args, {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe']
    })
    let stderr = ''
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
      if (stderr.length > 256_000) stderr = stderr.slice(-128_000)
    })
    proc.on('error', reject)
    proc.on('close', (code) => resolve({ code: code ?? 1, stderr }))
  })
}

function sanitizeMetaValue(value: string): string {
  // Strip control chars (incl. newlines) — ffmpeg -metadata values are single-line.
  return value.replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * Write user prompt + seed into container metadata (stream copy, no re-encode).
 */
export async function writeVideoUserMeta(
  filePath: string,
  opts: { prompt?: string; seed?: number | null }
): Promise<{ ok: boolean; error?: string }> {
  const path = (filePath || '').trim()
  if (!path || !existsSync(path)) {
    return { ok: false, error: 'Video path not found' }
  }

  const promptRaw = typeof opts.prompt === 'string' ? opts.prompt : ''
  const prompt = sanitizeMetaValue(promptRaw).slice(0, MAX_PROMPT_CHARS)
  const seed =
    typeof opts.seed === 'number' && Number.isFinite(opts.seed) ? Math.floor(opts.seed) : null

  if (!prompt && seed == null) {
    return { ok: true }
  }

  const ffmpeg = resolveFfmpegPath()
  if (!ffmpeg) {
    return { ok: false, error: 'ffmpeg not found' }
  }

  const ext = extname(path) || '.mp4'
  // Same directory as dest — Windows rename fails across drives (EXDEV) if using os.tmpdir().
  const dir = dirname(path)
  const stem = basename(path, ext)
  const tmpOut = join(dir, `.${stem}.ninmeta-${process.pid}-${Date.now()}${ext}`)
  const backup = join(dir, `.${stem}.ninmeta-bak-${process.pid}-${Date.now()}${ext}`)
  try {
    const args = ['-y', '-i', path, '-c', 'copy', '-map_metadata', '0']
    if (prompt) {
      args.push('-metadata', `${META_PROMPT_KEY}=${prompt}`)
    }
    if (seed != null) {
      args.push('-metadata', `${META_SEED_KEY}=${String(seed)}`)
    }
    // MP4/MOV: store custom keys as usable tags
    if (/\.(mp4|m4v|mov)$/i.test(ext)) {
      args.push('-movflags', 'use_metadata_tags')
    }
    args.push(tmpOut)

    const result = await runFfmpeg(ffmpeg, args)
    if (result.code !== 0 || !existsSync(tmpOut)) {
      try {
        await rm(tmpOut, { force: true })
      } catch {
        /* ignore */
      }
      return {
        ok: false,
        error: result.stderr.trim().slice(-400) || `ffmpeg metadata write failed (${result.code})`
      }
    }

    await rename(path, backup)
    try {
      await rename(tmpOut, path)
    } catch (err) {
      try {
        await rename(backup, path)
      } catch {
        /* ignore */
      }
      throw err
    }
    try {
      await rm(backup, { force: true })
    } catch {
      /* ignore */
    }
    return { ok: true }
  } catch (err) {
    try {
      await rm(tmpOut, { force: true })
    } catch {
      /* ignore */
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function parseMetaBlock(stderr: string): Record<string, string> {
  const out: Record<string, string> = {}
  const lines = stderr.split(/\r?\n/)
  let inMeta = false
  for (const line of lines) {
    if (/^\s*Metadata:\s*$/i.test(line)) {
      inMeta = true
      continue
    }
    if (inMeta) {
      if (/^\s*Duration:/i.test(line)) {
        inMeta = false
        continue
      }
      if (/^\s*Stream #/i.test(line)) {
        inMeta = false
        continue
      }
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*:\s*(.*)$/)
      if (m) {
        const key = m[1].toLowerCase()
        const val = m[2].trim()
        if (key && !(key in out)) out[key] = val
      }
    }
  }
  return out
}

/**
 * Read nin_prompt / nin_seed via ffmpeg -i (metadata dumped on stderr).
 */
export async function readVideoUserMeta(filePath: string): Promise<VideoUserMeta> {
  const path = (filePath || '').trim()
  if (!path || !existsSync(path)) {
    return { prompt: null, seed: null }
  }
  const ffmpeg = resolveFfmpegPath()
  if (!ffmpeg) {
    return { prompt: null, seed: null }
  }

  try {
    // ffmpeg -i prints format info to stderr and exits non-zero without output file — expected.
    const result = await runFfmpeg(ffmpeg, ['-hide_banner', '-i', path])
    const tags = parseMetaBlock(result.stderr)
    const promptRaw = tags[META_PROMPT_KEY] || tags[META_PROMPT_KEY.toLowerCase()] || ''
    const seedRaw = tags[META_SEED_KEY] || tags[META_SEED_KEY.toLowerCase()] || ''
    const prompt = promptRaw.trim() ? promptRaw.trim() : null
    const seedNum = seedRaw.trim() ? Number(seedRaw.trim()) : NaN
    const seed = Number.isFinite(seedNum) ? Math.floor(seedNum) : null
    return { prompt, seed }
  } catch {
    return { prompt: null, seed: null }
  }
}

export function uniqueGalleryDest(outputFolder: string, baseName: string, ext: string): string {
  const primary = join(outputFolder, baseName)
  if (!existsSync(primary)) return primary
  const stem = baseName.toLowerCase().endsWith(ext.toLowerCase())
    ? baseName.slice(0, -ext.length)
    : baseName
  for (let i = 1; i <= 9999; i++) {
    const candidate = join(outputFolder, `${stem}_${String(i).padStart(4, '0')}${ext}`)
    if (!existsSync(candidate)) return candidate
  }
  return join(outputFolder, `${stem}_${Date.now()}${ext}`)
}
