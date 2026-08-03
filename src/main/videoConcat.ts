import { spawn, type ChildProcess } from 'child_process'
import { createRequire } from 'module'
import { existsSync } from 'fs'
import { mkdir, mkdtemp, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join, extname, basename, isAbsolute } from 'path'
import { copyFile } from 'fs/promises'
import { app } from 'electron'

const requireFromMain = createRequire(__filename)

export interface ConcatVideosOpts {
  paths: string[]
  outputFolder: string
  namePrefix?: string
}

export interface ConcatVideosResult {
  ok: boolean
  path?: string
  dir?: string
  error?: string
  mode?: 'copy' | 'reencode'
}

let activeProc: ChildProcess | null = null
let activeJobId = 0

export function cancelActiveConcat(): boolean {
  activeJobId += 1
  if (!activeProc) return false
  try {
    activeProc.kill('SIGTERM')
  } catch {
    try {
      activeProc.kill()
    } catch {
      /* ignore */
    }
  }
  activeProc = null
  return true
}

function unpackAsarPath(p: string): string {
  if (p.includes('app.asar')) {
    return p.replace('app.asar', 'app.asar.unpacked')
  }
  return p
}

function resolveFfmpegPath(): string | null {
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

  // Packaged extraResources fallback
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

  // Dev: beside project resources
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

function escapeConcatPath(filePath: string): string {
  // concat demuxer: single quotes; escape ' as '\''
  const normalized = filePath.replace(/\\/g, '/')
  return normalized.replace(/'/g, `'\\''`)
}

function buildOutputName(namePrefix: string): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')
    .replace('T', '_')
  const safePrefix =
    namePrefix.trim().replace(/[<>:"/\\|?*\x00-\x1f]+/g, '_').replace(/_+/g, '_') || 'MERGE'
  return `${safePrefix}_${stamp}.mp4`
}

function runFfmpeg(
  ffmpeg: string,
  args: string[],
  jobId: number
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg, args, {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe']
    })
    activeProc = proc
    let stderr = ''
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
      if (stderr.length > 64_000) stderr = stderr.slice(-32_000)
    })
    proc.on('error', (err) => {
      if (activeJobId === jobId) activeProc = null
      reject(err)
    })
    proc.on('close', (code) => {
      if (activeJobId === jobId) activeProc = null
      resolve({ code: code ?? 1, stderr })
    })
  })
}

export async function concatVideos(opts: ConcatVideosOpts): Promise<ConcatVideosResult> {
  const paths = (opts.paths || [])
    .map((p) => (typeof p === 'string' ? p.trim() : ''))
    .filter(Boolean)
  const outputFolder = (opts.outputFolder || '').trim()
  if (paths.length < 2) {
    return { ok: false, error: 'Need at least 2 videos to merge' }
  }
  if (!outputFolder) {
    return { ok: false, error: 'Output folder is empty' }
  }
  for (const p of paths) {
    if (!existsSync(p)) {
      return { ok: false, error: `Video not found: ${p}` }
    }
  }

  const ffmpeg = resolveFfmpegPath()
  if (!ffmpeg) {
    return { ok: false, error: 'ffmpeg not found' }
  }

  cancelActiveConcat()
  const jobId = ++activeJobId

  let tmpDir = ''
  try {
    await mkdir(outputFolder, { recursive: true })
    tmpDir = await mkdtemp(join(tmpdir(), 'nin-merge-'))
    const listPath = join(tmpDir, 'concat.txt')
    const listBody = paths.map((p) => `file '${escapeConcatPath(isAbsolute(p) ? p : p)}'`).join('\n')
    await writeFile(listPath, listBody, 'utf8')

    const baseName = buildOutputName(opts.namePrefix || 'MERGE')
    let dest = join(outputFolder, baseName)
    if (existsSync(dest)) {
      const stem = basename(baseName, extname(baseName))
      dest = join(outputFolder, `${stem}_${Date.now()}.mp4`)
    }

    const tmpOut = join(tmpDir, 'out.mp4')

    // 1) stream copy (fast) when codecs align
    const copyArgs = [
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      listPath,
      '-c',
      'copy',
      '-movflags',
      '+faststart',
      tmpOut
    ]
    let mode: 'copy' | 'reencode' = 'copy'
    try {
      const copyResult = await runFfmpeg(ffmpeg, copyArgs, jobId)
      if (jobId !== activeJobId) {
        return { ok: false, error: 'Merge cancelled' }
      }
      if (copyResult.code !== 0 || !existsSync(tmpOut)) {
        throw new Error(copyResult.stderr || `ffmpeg copy failed (code ${copyResult.code})`)
      }
    } catch (copyErr) {
      if (jobId !== activeJobId) {
        return { ok: false, error: 'Merge cancelled' }
      }
      // 2) re-encode fallback
      mode = 'reencode'
      try {
        if (existsSync(tmpOut)) await rm(tmpOut, { force: true })
      } catch {
        /* ignore */
      }
      const reArgs = [
        '-y',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        listPath,
        '-c:v',
        'libx264',
        '-preset',
        'fast',
        '-crf',
        '18',
        '-c:a',
        'aac',
        '-movflags',
        '+faststart',
        tmpOut
      ]
      const reResult = await runFfmpeg(ffmpeg, reArgs, jobId)
      if (jobId !== activeJobId) {
        return { ok: false, error: 'Merge cancelled' }
      }
      if (reResult.code !== 0 || !existsSync(tmpOut)) {
        const hint =
          copyErr instanceof Error ? copyErr.message.slice(0, 200) : String(copyErr).slice(0, 200)
        return {
          ok: false,
          error:
            reResult.stderr?.trim().slice(-400) ||
            `ffmpeg merge failed (copy then re-encode). ${hint}`
        }
      }
    }

    await copyFile(tmpOut, dest)
    return { ok: true, path: dest, dir: outputFolder, mode }
  } catch (err) {
    if (jobId !== activeJobId) {
      return { ok: false, error: 'Merge cancelled' }
    }
    const msg = err instanceof Error ? err.message : String(err)
    if (/ENOENT|not found|spawn/i.test(msg)) {
      return {
        ok: false,
        error: 'ffmpeg not found. Install ffmpeg or ensure ffmpeg-static is packaged.'
      }
    }
    return { ok: false, error: msg }
  } finally {
    if (tmpDir) {
      try {
        await rm(tmpDir, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
  }
}
