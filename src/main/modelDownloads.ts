import { app } from 'electron'
import { createWriteStream, existsSync } from 'fs'
import { mkdir, rename, rm, stat } from 'fs/promises'
import { join, dirname } from 'path'
import { get as httpsGet } from 'https'
import { get as httpGet } from 'http'
import type { IncomingMessage } from 'http'

export type ModelPackId =
  | 'dit'
  | 'speedLora'
  | 'wan22Lora'
  | 'upscale'
  | 'frameInterp'
  | 'vae'
  | 'clip'

export interface ModelDownloadProgress {
  packId: ModelPackId
  message: string
  pct: number
}

export interface ModelDownloadResult {
  ok: boolean
  path?: string
  message: string
}

type ProgressFn = (p: ModelDownloadProgress) => void

interface PackFile {
  url: string
  /** Path relative to models root (file destination). */
  relativePath: string
}

interface PackDef {
  id: ModelPackId
  /** Path relative to models root returned to settings (folder or file). */
  resultRelativePath: string
  resultKind: 'folder' | 'file'
  files: PackFile[]
}

const WAN22_HF =
  'https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files'

const PACKS: Record<ModelPackId, PackDef> = {
  dit: {
    id: 'dit',
    resultRelativePath: join('diffusion_models', 'Wan'),
    resultKind: 'folder',
    files: [
      {
        url: `${WAN22_HF}/diffusion_models/wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors`,
        relativePath: join(
          'diffusion_models',
          'Wan',
          'wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors'
        )
      },
      {
        url: `${WAN22_HF}/diffusion_models/wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors`,
        relativePath: join(
          'diffusion_models',
          'Wan',
          'wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors'
        )
      }
    ]
  },
  speedLora: {
    id: 'speedLora',
    resultRelativePath: join('loras', 'Speed'),
    resultKind: 'folder',
    files: [
      {
        url: `${WAN22_HF}/loras/wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors`,
        relativePath: join(
          'loras',
          'Speed',
          'wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors'
        )
      },
      {
        url: `${WAN22_HF}/loras/wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors`,
        relativePath: join(
          'loras',
          'Speed',
          'wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors'
        )
      }
    ]
  },
  wan22Lora: {
    id: 'wan22Lora',
    resultRelativePath: join('loras', 'Wan'),
    resultKind: 'folder',
    files: []
  },
  upscale: {
    id: 'upscale',
    resultRelativePath: 'upscale_models',
    resultKind: 'folder',
    files: [
      {
        url: 'https://huggingface.co/Kim2091/UltraSharp/resolve/main/4x-UltraSharp.pth',
        relativePath: join('upscale_models', '4x-UltraSharp.pth')
      }
    ]
  },
  frameInterp: {
    id: 'frameInterp',
    resultRelativePath: 'frame_interpolation',
    resultKind: 'folder',
    files: [
      {
        url: 'https://huggingface.co/Comfy-Org/frame_interpolation/resolve/main/frame_interpolation/rife_v4.26.safetensors',
        relativePath: join('frame_interpolation', 'rife_v4.26.safetensors')
      }
    ]
  },
  vae: {
    id: 'vae',
    resultRelativePath: join('vae', 'wan_2.1_vae.safetensors'),
    resultKind: 'file',
    files: [
      {
        url: `${WAN22_HF}/vae/wan_2.1_vae.safetensors`,
        relativePath: join('vae', 'wan_2.1_vae.safetensors')
      }
    ]
  },
  clip: {
    id: 'clip',
    resultRelativePath: join(
      'text_encoders',
      'umt5_xxl_fp8_e4m3fn_scaled.safetensors'
    ),
    resultKind: 'file',
    files: [
      {
        url: `${WAN22_HF}/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors`,
        relativePath: join('text_encoders', 'umt5_xxl_fp8_e4m3fn_scaled.safetensors')
      }
    ]
  }
}

let downloadCancelled = false
let downloadRunning = false
let activeResponse: IncomingMessage | null = null
let activeWrite: ReturnType<typeof createWriteStream> | null = null

export function modelDownloadRunning(): boolean {
  return downloadRunning
}

export function cancelModelDownload(): { ok: boolean } {
  downloadCancelled = true
  try {
    activeResponse?.destroy(new Error('Cancelled'))
  } catch {
    // ignore
  }
  try {
    activeWrite?.destroy()
  } catch {
    // ignore
  }
  activeResponse = null
  activeWrite = null
  return { ok: true }
}

function modelsRootFromDownloadFolder(downloadFolder?: string): string {
  const trimmed = (downloadFolder || '').trim()
  const base = trimmed || app.getPath('userData')
  return join(base, 'models')
}

function isPackId(value: string): value is ModelPackId {
  return Object.prototype.hasOwnProperty.call(PACKS, value)
}

function httpsGetFollow(url: string, redirects = 0): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const getter = url.startsWith('http://') ? httpGet : httpsGet
    const req = getter(url, (res) => {
      if (
        res.statusCode &&
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location &&
        redirects < 8
      ) {
        res.resume()
        resolve(httpsGetFollow(res.headers.location, redirects + 1))
        return
      }
      if (!res.statusCode || res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`))
        res.resume()
        return
      }
      resolve(res)
    })
    req.on('error', reject)
  })
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function downloadFileWithProgress(
  url: string,
  dest: string,
  onBytes: (downloaded: number, total: number | null) => void
): Promise<void> {
  if (downloadCancelled) throw new Error('Cancelled')
  await mkdir(dirname(dest), { recursive: true })
  const partial = `${dest}.partial`
  if (existsSync(partial)) {
    await rm(partial, { force: true })
  }

  const res = await httpsGetFollow(url)
  if (downloadCancelled) {
    res.destroy()
    throw new Error('Cancelled')
  }
  activeResponse = res

  const totalHeader = res.headers['content-length']
  const total = totalHeader ? Number(totalHeader) : null
  let downloaded = 0

  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(partial)
    activeWrite = out

    res.on('data', (chunk: Buffer) => {
      if (downloadCancelled) {
        res.destroy()
        out.destroy()
        reject(new Error('Cancelled'))
        return
      }
      downloaded += chunk.length
      onBytes(downloaded, Number.isFinite(total) ? total : null)
    })

    res.on('error', (err) => {
      out.destroy()
      reject(err)
    })

    out.on('error', reject)
    out.on('finish', () => resolve())

    res.pipe(out)
  })

  activeResponse = null
  activeWrite = null

  if (downloadCancelled) {
    await rm(partial, { force: true }).catch(() => undefined)
    throw new Error('Cancelled')
  }

  if (existsSync(dest)) {
    await rm(dest, { force: true })
  }
  await rename(partial, dest)
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export async function downloadModelPack(
  packId: string,
  downloadFolder: string | undefined,
  onProgress?: ProgressFn
): Promise<ModelDownloadResult> {
  if (!isPackId(packId)) {
    return { ok: false, message: `Unknown model pack: ${packId}` }
  }
  if (downloadRunning) {
    return { ok: false, message: 'A model download is already running' }
  }

  const pack = PACKS[packId]
  const modelsRoot = modelsRootFromDownloadFolder(downloadFolder)
  const resultPath = join(modelsRoot, pack.resultRelativePath)

  downloadRunning = true
  downloadCancelled = false

  const report = (message: string, pct: number) => {
    onProgress?.({ packId, message, pct: Math.max(0, Math.min(100, Math.round(pct))) })
  }

  try {
    await mkdir(
      pack.resultKind === 'folder' ? resultPath : dirname(resultPath),
      { recursive: true }
    )

    if (pack.files.length === 0) {
      report('Folder ready', 100)
      return { ok: true, path: resultPath, message: 'Folder created' }
    }

    const fileCount = pack.files.length
    for (let i = 0; i < fileCount; i++) {
      if (downloadCancelled) throw new Error('Cancelled')
      const file = pack.files[i]
      const dest = join(modelsRoot, file.relativePath)
      const base = dest.split(/[/\\]/).pop() || file.relativePath
      const fileBasePct = (i / fileCount) * 100
      const fileSpan = 100 / fileCount

      if (await pathExists(dest)) {
        report(`Already have ${base}`, fileBasePct + fileSpan)
        continue
      }

      report(`Downloading ${base}…`, fileBasePct)
      await downloadFileWithProgress(urlWithDownloadFlag(file.url), dest, (downloaded, total) => {
        const filePct =
          total && total > 0 ? (downloaded / total) * fileSpan : Math.min(fileSpan * 0.95, fileSpan)
        const label =
          total && total > 0
            ? `Downloading ${base}… ${formatBytes(downloaded)} / ${formatBytes(total)}`
            : `Downloading ${base}… ${formatBytes(downloaded)}`
        report(label, fileBasePct + filePct)
      })
    }

    report('Download complete', 100)
    return { ok: true, path: resultPath, message: 'Download complete' }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message === 'Cancelled' || downloadCancelled) {
      return { ok: false, message: 'Cancelled' }
    }
    return { ok: false, message }
  } finally {
    downloadRunning = false
    downloadCancelled = false
    activeResponse = null
    activeWrite = null
  }
}

/** Prefer resolve URL that triggers content disposition download on HF. */
function urlWithDownloadFlag(url: string): string {
  if (url.includes('huggingface.co') && !url.includes('?')) {
    return `${url}?download=true`
  }
  return url
}
