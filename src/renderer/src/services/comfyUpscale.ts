/**
 * Upscale / Interpolation post-process workflow for gallery videos.
 * Load video → optional UpscaleModelLoader+ImageUpscaleWithModel →
 * optional FrameInterpolate → NINI2VSaveVideo.
 */

import {
  type VideoSaveBitDepth,
  type VideoSaveCodec,
  type VideoSaveFormat
} from '../defaults/i2vGenerate'
import {
  basenamePath,
  COMFY_BASE_URL,
  interruptComfyGeneration,
  probeComfyOnline,
  type ComfyVideoRef
} from './comfyI2v'
import { probeVideoNodeCaps, type VideoNodeCaps } from './comfyWan22Loop'

export { COMFY_BASE_URL, interruptComfyGeneration, probeComfyOnline, basenamePath }
export type { ComfyVideoRef }

export const UPSCALE_NODE = {
  loadVideo: '1',
  upscaleModel: '2',
  upscale: '3',
  imageScale: '7',
  interpModel: '4',
  interpolate: '5',
  saveVideo: '6'
} as const

export interface ComfyUpscaleParams {
  uploadedVideoName: string
  uploadedVideoSubfolder?: string
  /** Basename for UpscaleModelLoader; used when targeting a resolution. */
  upscaleModelName?: string
  /** Target pixel size from resolution preset (WAN Div32). Omit / 0 = skip resize upscale. */
  targetWidth?: number
  targetHeight?: number
  /** 1 = skip interpolation */
  interpolationScale: number
  /** Preferred FrameInterpolate model name (optional). */
  interpolationModelName?: string
  /** Source video fps (before interpolation). */
  fps: number
  savePrefix?: string
  videoFormat?: VideoSaveFormat
  videoCodec?: VideoSaveCodec
  videoBitDepth?: VideoSaveBitDepth
  videoCrf?: number
}

export interface UpscaleNodeCaps {
  hasNinLoadVideo: boolean
  hasUpscaleModelLoader: boolean
  hasImageUpscaleWithModel: boolean
  hasFrameInterpLoader: boolean
  hasFrameInterpolate: boolean
  hasNinSaveVideo: boolean
  interpModelOptions: string[]
  videoCaps: VideoNodeCaps
}

function clientId(): string {
  return `i2vmaker-upscale-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

async function comfyHttp(
  url: string,
  init?: { method?: string; body?: string; timeoutMs?: number }
): Promise<{ ok: boolean; status: number; text: string; error?: string }> {
  return window.api.comfyHttpRequest({
    url,
    method: init?.method || 'GET',
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    body: init?.body,
    timeoutMs: init?.timeoutMs
  })
}

function videoRef(name: string, subfolder?: string): string {
  return subfolder ? `${subfolder}/${name}` : name
}

function collectComboOptions(nodeInfo: Record<string, unknown> | undefined, inputName: string): string[] {
  if (!nodeInfo) return []
  const input = (nodeInfo.input || nodeInfo.inputs) as Record<string, unknown> | undefined
  if (!input) return []
  const required = (input.required || {}) as Record<string, unknown>
  const optional = (input.optional || {}) as Record<string, unknown>
  const spec = (required[inputName] || optional[inputName]) as unknown
  if (!Array.isArray(spec) || spec.length === 0) return []
  const first = spec[0]
  // Legacy: [["a","b"], {default:...}]
  if (Array.isArray(first)) {
    return first.filter((x): x is string => typeof x === 'string')
  }
  // Modern Comfy: ["COMBO", { options: ["a","b"], ... }]
  if (first === 'COMBO' && spec[1] && typeof spec[1] === 'object') {
    const opts = (spec[1] as { options?: unknown }).options
    if (Array.isArray(opts)) {
      return opts.filter((x): x is string => typeof x === 'string')
    }
  }
  return []
}

export async function probeUpscaleNodeCaps(baseUrl: string): Promise<UpscaleNodeCaps> {
  const base = baseUrl.replace(/\/$/, '')
  const videoCaps = await probeVideoNodeCaps(base)
  const caps: UpscaleNodeCaps = {
    hasNinLoadVideo: false,
    hasUpscaleModelLoader: false,
    hasImageUpscaleWithModel: false,
    hasFrameInterpLoader: false,
    hasFrameInterpolate: false,
    hasNinSaveVideo: videoCaps.hasNinSaveVideo,
    interpModelOptions: [],
    videoCaps
  }
  try {
    const names = [
      'NINI2VLoadVideo',
      'UpscaleModelLoader',
      'ImageUpscaleWithModel',
      'FrameInterpolationModelLoader',
      'FrameInterpolate'
    ]
    const results = await Promise.all(
      names.map((n) => comfyHttp(`${base}/object_info/${n}`, { timeoutMs: 15_000 }))
    )
    for (let i = 0; i < names.length; i++) {
      const res = results[i]
      if (!res.ok || !res.text) continue
      try {
        const parsed = JSON.parse(res.text) as Record<string, Record<string, unknown>>
        const info = parsed[names[i]]
        if (!info) continue
        if (names[i] === 'NINI2VLoadVideo') caps.hasNinLoadVideo = true
        if (names[i] === 'UpscaleModelLoader') caps.hasUpscaleModelLoader = true
        if (names[i] === 'ImageUpscaleWithModel') caps.hasImageUpscaleWithModel = true
        if (names[i] === 'FrameInterpolationModelLoader') {
          caps.hasFrameInterpLoader = true
          caps.interpModelOptions = collectComboOptions(info, 'model_name')
          if (caps.interpModelOptions.length === 0) {
            caps.interpModelOptions = collectComboOptions(info, 'ckpt_name')
          }
        }
        if (names[i] === 'FrameInterpolate') caps.hasFrameInterpolate = true
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* use defaults */
  }
  return caps
}

function pickFromOptions(wanted: string, options: string[] | null, fallbacks: string[]): string {
  if (!options || options.length === 0) {
    if (fallbacks.includes(wanted)) return wanted
    return fallbacks[0] || wanted
  }
  if (options.includes(wanted)) return wanted
  for (const fb of fallbacks) {
    if (options.includes(fb)) return fb
  }
  return options[0]
}

function pickCodec(p: ComfyUpscaleParams, caps: VideoNodeCaps): string {
  let wanted = (p.videoCodec || 'h264').trim() || 'h264'
  if (wanted === 'auto') wanted = 'h264'
  return pickFromOptions(wanted, caps.codecOptions, ['h264', 'h265', 'av1', 'vp9', 'prores'])
}

function pickFormat(p: ComfyUpscaleParams, caps: VideoNodeCaps): string {
  const wanted = (p.videoFormat || 'auto').trim() || 'auto'
  return pickFromOptions(wanted, caps.formatOptions, ['auto', 'mp4', 'webm', 'mkv'])
}

function pickInterpModel(p: ComfyUpscaleParams, caps: UpscaleNodeCaps): string {
  const preferred = (p.interpolationModelName || '').trim()
  const options = caps.interpModelOptions
  if (preferred && options.includes(preferred)) return preferred
  const rife = options.find((n) => /rife_v4\.26/i.test(n))
  if (rife) return rife
  const anyRife = options.find((n) => /rife/i.test(n))
  if (anyRife) return anyRife
  if (options.length > 0) return options[0]
  return preferred || 'rife_v4.26.safetensors'
}

export function buildUpscaleWorkflow(
  p: ComfyUpscaleParams,
  caps: UpscaleNodeCaps
): Record<string, unknown> {
  const targetW = Math.max(0, Math.floor(p.targetWidth || 0))
  const targetH = Math.max(0, Math.floor(p.targetHeight || 0))
  const doUpscale = targetW >= 32 && targetH >= 32
  const doInterp = p.interpolationScale > 1
  const outFps =
    doInterp && p.interpolationScale > 1
      ? Math.max(1, p.fps * p.interpolationScale)
      : Math.max(1, p.fps)

  const graph: Record<string, unknown> = {
    [UPSCALE_NODE.loadVideo]: {
      class_type: 'NINI2VLoadVideo',
      inputs: {
        video: videoRef(p.uploadedVideoName, p.uploadedVideoSubfolder)
      }
    }
  }

  let imagesNode: string = UPSCALE_NODE.loadVideo

  if (doUpscale) {
    const modelName = (p.upscaleModelName || '').trim()
    if (modelName) {
      graph[UPSCALE_NODE.upscaleModel] = {
        class_type: 'UpscaleModelLoader',
        inputs: {
          model_name: modelName
        }
      }
      graph[UPSCALE_NODE.upscale] = {
        class_type: 'ImageUpscaleWithModel',
        inputs: {
          upscale_model: [UPSCALE_NODE.upscaleModel, 0],
          image: [imagesNode, 0]
        }
      }
      imagesNode = UPSCALE_NODE.upscale
    }
    graph[UPSCALE_NODE.imageScale] = {
      class_type: 'ImageScale',
      inputs: {
        image: [imagesNode, 0],
        width: targetW,
        height: targetH,
        upscale_method: 'lanczos',
        crop: 'disabled'
      }
    }
    imagesNode = UPSCALE_NODE.imageScale
  }

  if (doInterp) {
    const interpModel = pickInterpModel(p, caps)
    graph[UPSCALE_NODE.interpModel] = {
      class_type: 'FrameInterpolationModelLoader',
      inputs: {
        model_name: interpModel
      }
    }
    graph[UPSCALE_NODE.interpolate] = {
      class_type: 'FrameInterpolate',
      inputs: {
        images: [imagesNode, 0],
        interp_model: [UPSCALE_NODE.interpModel, 0],
        multiplier: Math.max(2, Math.round(p.interpolationScale))
      }
    }
    imagesNode = UPSCALE_NODE.interpolate
  }

  const format = pickFormat(p, caps.videoCaps)
  const codec = pickCodec(p, caps.videoCaps)
  const crf = Math.min(63, Math.max(0, Math.round(p.videoCrf ?? 23)))
  graph[UPSCALE_NODE.saveVideo] = {
    class_type: 'NINI2VSaveVideo',
    inputs: {
      images: [imagesNode, 0],
      fps: outFps,
      filename_prefix: p.savePrefix || 'upscale/Wan2.2',
      filename_suffix: '_upscale',
      format,
      codec,
      bit_depth: p.videoBitDepth === 10 ? 10 : 8,
      crf
    }
  }

  return graph
}

async function waitForPromptDone(
  promptId: string,
  baseUrl: string,
  signal?: AbortSignal,
  timeoutMs = 3_600_000,
  onProgress?: (message: string) => void,
  liveProgressAt?: { current: number }
): Promise<Record<string, unknown>> {
  const start = Date.now()
  let lastProgressKey = ''
  const report = (message: string) => {
    if (message === lastProgressKey) return
    lastProgressKey = message
    onProgress?.(message)
  }

  while (Date.now() - start < timeoutMs) {
    if (signal?.aborted) throw new Error('Upscale cancelled')
    const res = await comfyHttp(`${baseUrl}/history/${promptId}`, { timeoutMs: 30_000 })
    if (res.ok && res.text) {
      try {
        const hist = JSON.parse(res.text) as Record<
          string,
          {
            outputs?: Record<string, unknown>
            status?: { status_str?: string; completed?: boolean; messages?: unknown }
          }
        >
        const entry = hist[promptId]
        if (entry) {
          const statusStr = entry.status?.status_str
          if (statusStr === 'error') {
            const statusFull = entry.status as Record<string, unknown> | undefined
            const messages = statusFull?.messages
            let exceptionMessage = ''
            let nodeType = ''
            if (Array.isArray(messages)) {
              for (const m of messages) {
                if (!Array.isArray(m) || m[0] !== 'execution_error') continue
                const detail = m[1] as Record<string, unknown> | undefined
                if (!detail) continue
                exceptionMessage = String(detail.exception_message || detail.message || '')
                nodeType = String(detail.node_type ?? '')
              }
            }
            const detail =
              exceptionMessage || nodeType
                ? ` (${nodeType}: ${exceptionMessage || 'unknown'})`
                : ''
            throw new Error(`ComfyUI reported an error while upscaling${detail}`)
          }
          if (entry.status?.completed || entry.outputs) {
            return entry as unknown as Record<string, unknown>
          }
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('ComfyUI')) throw err
      }
    }
    const liveAt = liveProgressAt?.current ?? 0
    // Keep last WS progress (e.g. step x/x); only fallback before any live update.
    if (liveAt < start) {
      const elapsedSec = Math.floor((Date.now() - start) / 1000)
      report(`Upscale / interpolate… ${elapsedSec}s`)
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error(`Timed out waiting for ComfyUI (${Math.round(timeoutMs / 60000)} min)`)
}

function collectVideoRefs(outputs: Record<string, unknown> | undefined): ComfyVideoRef[] {
  if (!outputs) return []
  const refs: ComfyVideoRef[] = []
  for (const nodeOut of Object.values(outputs)) {
    if (!nodeOut || typeof nodeOut !== 'object') continue
    const o = nodeOut as Record<string, unknown>
    for (const key of ['videos', 'gifs', 'images']) {
      const arr = o[key]
      if (!Array.isArray(arr)) continue
      for (const item of arr) {
        if (!item || typeof item !== 'object') continue
        const v = item as Record<string, unknown>
        if (typeof v.filename !== 'string') continue
        refs.push({
          filename: v.filename,
          subfolder: typeof v.subfolder === 'string' ? v.subfolder : '',
          type: typeof v.type === 'string' ? v.type : 'output',
          format: typeof v.format === 'string' ? v.format : undefined
        })
      }
    }
  }
  return refs
}

function describeNode(nodeId: string | null | undefined): string {
  if (!nodeId) return 'ComfyUI'
  const map: Record<string, string> = {
    [UPSCALE_NODE.loadVideo]: 'Load video',
    [UPSCALE_NODE.upscaleModel]: 'Load upscale model',
    [UPSCALE_NODE.upscale]: 'Upscale frames',
    [UPSCALE_NODE.imageScale]: 'Scale to target resolution',
    [UPSCALE_NODE.interpModel]: 'Load interpolation model',
    [UPSCALE_NODE.interpolate]: 'Frame interpolate',
    [UPSCALE_NODE.saveVideo]: 'Save video'
  }
  return map[nodeId] || `Node ${nodeId}`
}

async function openComfyProgressWs(
  baseUrl: string,
  clientIdStr: string,
  promptIdRef: { current: string },
  liveProgressAt: { current: number },
  onProgress?: (message: string) => void
): Promise<{ close: () => void }> {
  const noop = { close: () => undefined }
  if (!onProgress) return noop

  let currentNode: string | null = null
  let closed = false

  const push = (message: string) => {
    if (closed) return
    liveProgressAt.current = Date.now()
    onProgress(message)
  }

  const off = window.api.onComfyProgress((msg) => {
    if (closed) return
    try {
      const data = msg.data || {}
      const pid = promptIdRef.current
      if (pid && data.prompt_id && data.prompt_id !== pid) return

      if (msg.type === 'executing') {
        currentNode = data.node ?? null
        if (!currentNode) return
        push(`Running: ${describeNode(currentNode)}`)
        return
      }

      if (msg.type === 'progress') {
        const value = Number(data.value)
        const max = Number(data.max)
        if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return
        const step = Math.max(0, Math.floor(value))
        const total = Math.max(1, Math.floor(max))
        const displayStep = step <= 0 ? 1 : Math.min(step, total)
        const node = currentNode || data.node || null
        push(`${describeNode(node)} — step ${displayStep}/${total}`)
      }
    } catch {
      /* ignore */
    }
  })

  const connect = await window.api.comfyProgressConnect({
    baseUrl,
    clientId: clientIdStr
  })
  if (!connect.ok) {
    off()
    onProgress(`Progress WS unavailable: ${connect.error || 'unknown'} — polling history only`)
    return noop
  }

  return {
    close: () => {
      closed = true
      off()
      void window.api.comfyProgressDisconnect()
    }
  }
}

export async function generateUpscaleWithComfy(
  params: ComfyUpscaleParams,
  opts?: {
    signal?: AbortSignal
    baseUrl?: string
    onProgress?: (message: string) => void
  }
): Promise<{ promptId: string; videos: ComfyVideoRef[] }> {
  const baseUrl = (opts?.baseUrl || COMFY_BASE_URL).replace(/\/$/, '')
  const signal = opts?.signal
  const onProgress = opts?.onProgress

  const targetW = Math.max(0, Math.floor(params.targetWidth || 0))
  const targetH = Math.max(0, Math.floor(params.targetHeight || 0))
  const doUpscale = targetW >= 32 && targetH >= 32
  if (!doUpscale && params.interpolationScale <= 1) {
    throw new Error('Set Upscale Resolution or Interpolation scale above 1')
  }

  onProgress?.('Probing ComfyUI upscale nodes…')
  const caps = await probeUpscaleNodeCaps(baseUrl)
  if (!caps.hasNinSaveVideo) {
    throw new Error(
      'NINI2VSaveVideo custom node not loaded. Stop ComfyUI and Start again so NIN custom nodes can install.'
    )
  }
  if (!caps.hasNinLoadVideo) {
    throw new Error(
      'NINI2VLoadVideo custom node not loaded. Stop ComfyUI and Start again so NIN custom nodes can install.'
    )
  }
  if (doUpscale && (params.upscaleModelName || '').trim()) {
    if (!caps.hasUpscaleModelLoader || !caps.hasImageUpscaleWithModel) {
      throw new Error(
        'UpscaleModelLoader / ImageUpscaleWithModel not found. Update ComfyUI core nodes and restart.'
      )
    }
  }
  if (params.interpolationScale > 1) {
    if (!caps.hasFrameInterpLoader || !caps.hasFrameInterpolate) {
      throw new Error(
        'FrameInterpolate nodes not found. Update ComfyUI (frame interpolation extras) and restart.'
      )
    }
    if (caps.interpModelOptions.length === 0) {
      throw new Error(
        'No frame interpolation models in ComfyUI models/frame_interpolation. Set Interpolation scale to 1, or place RIFE (etc.) models there and restart ComfyUI.'
      )
    }
  }

  onProgress?.('Building upscale workflow…')
  const workflow = buildUpscaleWorkflow(params, caps)
  const cid = clientId()
  const promptIdRef = { current: '' }
  const liveProgressAt = { current: 0 }

  onProgress?.('Connecting ComfyUI progress…')
  const ws = await openComfyProgressWs(baseUrl, cid, promptIdRef, liveProgressAt, onProgress)

  try {
    onProgress?.('Queuing upscale prompt…')
    const body = JSON.stringify({
      prompt: workflow,
      client_id: cid
    })

    const queued = await comfyHttp(`${baseUrl}/prompt`, {
      method: 'POST',
      body,
      timeoutMs: 60_000
    })
    if (!queued.ok) {
      let detail = queued.error || queued.text || 'unknown'
      try {
        const p = JSON.parse(queued.text || '{}') as {
          error?: { message?: string; type?: string }
          node_errors?: Record<string, { class_type?: string; errors?: { details?: string; message?: string }[] }>
        }
        const parts: string[] = []
        if (p.error?.message) parts.push(p.error.message)
        if (p.node_errors) {
          for (const [nid, ne] of Object.entries(p.node_errors)) {
            const err0 = ne.errors?.[0]
            const tip = err0?.details || err0?.message || ''
            parts.push(`node ${nid} (${ne.class_type || '?'}): ${tip}`)
          }
        }
        if (parts.length > 0) detail = parts.join(' — ')
      } catch {
        /* keep raw */
      }
      throw new Error(`ComfyUI /prompt failed (${queued.status}): ${detail}`)
    }

    let promptId = ''
    try {
      const parsed = JSON.parse(queued.text) as { prompt_id?: string; error?: unknown }
      if (parsed.error) {
        throw new Error(`ComfyUI rejected prompt: ${JSON.stringify(parsed.error)}`)
      }
      promptId = parsed.prompt_id || ''
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('ComfyUI')) throw err
      throw new Error(`Invalid ComfyUI /prompt response: ${queued.text}`)
    }
    if (!promptId) throw new Error('ComfyUI returned empty prompt_id')
    promptIdRef.current = promptId

    onProgress?.('Queued — upscale / interpolate…')
    const done = await waitForPromptDone(
      promptId,
      baseUrl,
      signal,
      3_600_000,
      onProgress,
      liveProgressAt
    )
    onProgress?.('ComfyUI finished — collecting video outputs…')
    const outputs = (done as { outputs?: Record<string, unknown> }).outputs
    const videos = collectVideoRefs(outputs)
    if (videos.length === 0) {
      throw new Error('ComfyUI finished but no video was found in outputs')
    }
    return { promptId, videos }
  } finally {
    ws.close()
  }
}
