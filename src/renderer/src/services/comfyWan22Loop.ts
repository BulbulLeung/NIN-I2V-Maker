/**
 * Wan2.2 Loop workflow API graph (I2V / FLF2V / WanFunInpaint).
 * Mirrors generation path of Wan22 Video(Loop) Settings subgraph — no Interpolation / Upscale / Mini Meme.
 */

import {
  framesFromSeconds,
  type Wan22VideoMode
} from '../defaults/i2vGenerate'
import {
  basenamePath,
  COMFY_BASE_URL,
  interruptComfyGeneration,
  probeComfyOnline,
  type ComfyVideoRef
} from './comfyI2v'

export { COMFY_BASE_URL, interruptComfyGeneration, probeComfyOnline, basenamePath }
export type { ComfyVideoRef }

/** Stable node ids in the API template (also documented in resources/workflows/wan22-loop-api.json). */
export const WAN22_NODE = {
  unetHigh: '1',
  unetLow: '2',
  clip: '3',
  vae: '4',
  positive: '5',
  negative: '6',
  startImage: '7',
  endImage: '8',
  wanCond: '9',
  shiftHigh: '10',
  shiftLow: '11',
  loraHigh: '12',
  loraLow: '13',
  samplerHigh: '14',
  samplerLow: '15',
  vaeDecode: '16',
  createVideo: '17',
  saveVideo: '18'
} as const

export interface ComfyWan22LoopParams {
  mode: Wan22VideoMode
  prompt: string
  negative: string
  steps: number
  refinerStep: number
  cfg: number
  cfgHigh: number
  seed: number
  width: number
  height: number
  seconds: number
  fps: number
  shift: number
  sampler: string
  scheduler: string
  highDitName: string
  lowDitName: string
  vaeName: string
  clipName: string
  loraHighName?: string
  loraLowName?: string
  loraHighStrength?: number
  loraLowStrength?: number
  /** @deprecated Prefer loraHighStrength / loraLowStrength. */
  loraStrength?: number
  useLightningLora?: boolean
  /** Extra LoRAs on the high-noise model chain. */
  extraLorasHigh?: { name: string; strength: number }[]
  /** Extra LoRAs on the low-noise model chain. */
  extraLorasLow?: { name: string; strength: number }[]
  /** @deprecated Prefer extraLorasHigh / extraLorasLow. */
  extraLoras?: { name: string; strength: number }[]
  uploadedStartImage: string
  uploadedStartSubfolder?: string
  uploadedEndImage?: string
  uploadedEndSubfolder?: string
  savePrefix?: string
}

function clientId(): string {
  return `i2vmaker-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
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

function imageRef(name: string, subfolder?: string): string {
  return subfolder ? `${subfolder}/${name}` : name
}

function wanClassType(mode: Wan22VideoMode): string {
  if (mode === 'flf2v') return 'WanFirstLastFrameToVideo'
  if (mode === 'wanfun_inpaint') return 'WanFunInpaintToVideo'
  return 'WanImageToVideo'
}

/** Chain LoraLoaderModelOnly nodes; returns the tip node id for KSampler.model. */
function appendLoraChain(
  graph: Record<string, unknown>,
  startNode: string,
  side: 'h' | 'l',
  speed: { name: string; strength: number } | null,
  extras: { name: string; strength: number }[]
): string {
  let current = startNode
  if (speed) {
    const id = side === 'h' ? WAN22_NODE.loraHigh : WAN22_NODE.loraLow
    graph[id] = {
      class_type: 'LoraLoaderModelOnly',
      inputs: {
        model: [current, 0],
        lora_name: speed.name,
        strength_model: speed.strength
      }
    }
    current = id
  }
  for (let i = 0; i < extras.length; i++) {
    const lora = extras[i]
    const id = `extra_${side}_${i}`
    graph[id] = {
      class_type: 'LoraLoaderModelOnly',
      inputs: {
        model: [current, 0],
        lora_name: lora.name,
        strength_model: lora.strength
      }
    }
    current = id
  }
  return current
}

/**
 * Build API prompt graph aligned with Wan22 Loop generation (dual UNET + dual KSampler).
 * Post-processing (interp / upscale / mini meme) is omitted by design.
 */
export function buildWan22LoopWorkflow(p: ComfyWan22LoopParams): Record<string, unknown> {
  const legacyStrength = p.loraStrength ?? 0.8
  const highStrength = p.loraHighStrength ?? legacyStrength
  const lowStrength = p.loraLowStrength ?? legacyStrength
  const useSpeedLora =
    Boolean(p.useLightningLora) &&
    Boolean((p.loraHighName || '').trim()) &&
    Boolean((p.loraLowName || '').trim())
  const mapExtras = (list: { name: string; strength: number }[] | undefined) =>
    (list || [])
      .map((e) => ({
        name: (e.name || '').trim(),
        strength: Number.isFinite(e.strength) ? e.strength : 1
      }))
      .filter((e) => e.name.length > 0)
  const extrasHigh = mapExtras(p.extraLorasHigh ?? p.extraLoras)
  const extrasLow = mapExtras(p.extraLorasLow ?? p.extraLoras)

  const steps = Math.max(2, Math.floor(p.steps))
  const refiner = Math.min(steps - 1, Math.max(1, Math.floor(p.refinerStep)))
  const seed =
    p.seed < 0 ? Math.floor(Math.random() * 1_000_000_000_000) : Math.floor(p.seed)
  const length = framesFromSeconds(p.seconds, p.fps)
  const needsEnd = p.mode === 'flf2v' || p.mode === 'wanfun_inpaint'

  const wanInputs: Record<string, unknown> = {
    positive: [WAN22_NODE.positive, 0],
    negative: [WAN22_NODE.negative, 0],
    vae: [WAN22_NODE.vae, 0],
    start_image: [WAN22_NODE.startImage, 0],
    width: Math.floor(p.width),
    height: Math.floor(p.height),
    length,
    batch_size: 1
  }
  if (needsEnd) {
    wanInputs.end_image = [WAN22_NODE.endImage, 0]
  }

  const graph: Record<string, unknown> = {
    [WAN22_NODE.unetHigh]: {
      class_type: 'UNETLoader',
      inputs: {
        unet_name: p.highDitName,
        weight_dtype: 'default'
      }
    },
    [WAN22_NODE.unetLow]: {
      class_type: 'UNETLoader',
      inputs: {
        unet_name: p.lowDitName,
        weight_dtype: 'default'
      }
    },
    [WAN22_NODE.clip]: {
      class_type: 'CLIPLoader',
      inputs: {
        clip_name: p.clipName,
        type: 'wan',
        device: 'default'
      }
    },
    [WAN22_NODE.vae]: {
      class_type: 'VAELoader',
      inputs: {
        vae_name: p.vaeName
      }
    },
    [WAN22_NODE.positive]: {
      class_type: 'CLIPTextEncode',
      inputs: {
        text: p.prompt,
        clip: [WAN22_NODE.clip, 0]
      }
    },
    [WAN22_NODE.negative]: {
      class_type: 'CLIPTextEncode',
      inputs: {
        text: p.negative || '',
        clip: [WAN22_NODE.clip, 0]
      }
    },
    [WAN22_NODE.startImage]: {
      class_type: 'LoadImage',
      inputs: {
        image: imageRef(p.uploadedStartImage, p.uploadedStartSubfolder)
      }
    },
    [WAN22_NODE.wanCond]: {
      class_type: wanClassType(p.mode),
      inputs: wanInputs
    },
    [WAN22_NODE.shiftHigh]: {
      class_type: 'ModelSamplingSD3',
      inputs: {
        model: [WAN22_NODE.unetHigh, 0],
        shift: p.shift
      }
    },
    [WAN22_NODE.shiftLow]: {
      class_type: 'ModelSamplingSD3',
      inputs: {
        model: [WAN22_NODE.unetLow, 0],
        shift: p.shift
      }
    },
    [WAN22_NODE.vaeDecode]: {
      class_type: 'VAEDecode',
      inputs: {
        samples: [WAN22_NODE.samplerLow, 0],
        vae: [WAN22_NODE.vae, 0]
      }
    },
    [WAN22_NODE.createVideo]: {
      class_type: 'CreateVideo',
      inputs: {
        images: [WAN22_NODE.vaeDecode, 0],
        fps: p.fps
      }
    },
    [WAN22_NODE.saveVideo]: {
      class_type: 'SaveVideo',
      inputs: {
        video: [WAN22_NODE.createVideo, 0],
        filename_prefix: p.savePrefix || prefixForMode(p.mode),
        format: 'auto',
        codec: 'auto'
      }
    }
  }

  if (needsEnd) {
    const endName = (p.uploadedEndImage || '').trim()
    if (!endName) {
      throw new Error('End frame image is required for FLF2V / WanFunInpaint')
    }
    graph[WAN22_NODE.endImage] = {
      class_type: 'LoadImage',
      inputs: {
        image: imageRef(endName, p.uploadedEndSubfolder)
      }
    }
  }

  const speedHigh = useSpeedLora
    ? { name: (p.loraHighName || '').trim(), strength: highStrength }
    : null
  const speedLow = useSpeedLora
    ? { name: (p.loraLowName || '').trim(), strength: lowStrength }
    : null

  const highModelNode = appendLoraChain(
    graph,
    WAN22_NODE.shiftHigh,
    'h',
    speedHigh,
    extrasHigh
  )
  const lowModelNode = appendLoraChain(
    graph,
    WAN22_NODE.shiftLow,
    'l',
    speedLow,
    extrasLow
  )

  graph[WAN22_NODE.samplerHigh] = {
    class_type: 'KSamplerAdvanced',
    inputs: {
      model: [highModelNode, 0],
      add_noise: 'enable',
      noise_seed: seed,
      steps,
      cfg: p.cfgHigh,
      sampler_name: p.sampler,
      scheduler: p.scheduler,
      positive: [WAN22_NODE.wanCond, 0],
      negative: [WAN22_NODE.wanCond, 1],
      latent_image: [WAN22_NODE.wanCond, 2],
      start_at_step: 0,
      end_at_step: refiner,
      return_with_leftover_noise: 'enable'
    }
  }
  graph[WAN22_NODE.samplerLow] = {
    class_type: 'KSamplerAdvanced',
    inputs: {
      model: [lowModelNode, 0],
      add_noise: 'disable',
      noise_seed: 0,
      steps,
      cfg: p.cfg,
      sampler_name: p.sampler,
      scheduler: p.scheduler,
      positive: [WAN22_NODE.wanCond, 0],
      negative: [WAN22_NODE.wanCond, 1],
      latent_image: [WAN22_NODE.samplerHigh, 0],
      start_at_step: refiner,
      end_at_step: steps,
      return_with_leftover_noise: 'disable'
    }
  }

  return graph
}

function prefixForMode(mode: Wan22VideoMode): string {
  if (mode === 'flf2v') return 'flf2v/Wan2.2_flf2v'
  if (mode === 'wanfun_inpaint') return 'wanfun/Wan2.2_inpaint'
  return 'i2v/Wan2.2_i2v'
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
    if (signal?.aborted) throw new Error('Generation cancelled')
    const res = await comfyHttp(`${baseUrl}/history/${promptId}`, { timeoutMs: 30_000 })
    if (res.ok && res.text) {
      try {
        const hist = JSON.parse(res.text) as Record<
          string,
          {
            outputs?: Record<string, unknown>
            status?: { status_str?: string; completed?: boolean }
          }
        >
        const entry = hist[promptId]
        if (entry) {
          const statusStr = entry.status?.status_str
          if (statusStr === 'error') {
            throw new Error('ComfyUI reported an error while generating video')
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
    // Don't overwrite live sampler step updates with a generic wait message.
    if (Date.now() - liveAt > 2500) {
      const elapsedSec = Math.floor((Date.now() - start) / 1000)
      report(`Preparing models / encoding… ${elapsedSec}s`)
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
    [WAN22_NODE.unetHigh]: 'Load high DiT',
    [WAN22_NODE.unetLow]: 'Load low DiT',
    [WAN22_NODE.clip]: 'Load CLIP/UMT5',
    [WAN22_NODE.vae]: 'Load VAE',
    [WAN22_NODE.positive]: 'Encode positive prompt',
    [WAN22_NODE.negative]: 'Encode negative prompt',
    [WAN22_NODE.startImage]: 'Load start image',
    [WAN22_NODE.endImage]: 'Load end image',
    [WAN22_NODE.wanCond]: 'Wan conditioning',
    [WAN22_NODE.shiftHigh]: 'Model sampling (high)',
    [WAN22_NODE.shiftLow]: 'Model sampling (low)',
    [WAN22_NODE.loraHigh]: 'Apply Speed LoRA (high)',
    [WAN22_NODE.loraLow]: 'Apply Speed LoRA (low)',
    [WAN22_NODE.samplerHigh]: 'High-noise sampling',
    [WAN22_NODE.samplerLow]: 'Low-noise sampling',
    [WAN22_NODE.vaeDecode]: 'VAE decode',
    [WAN22_NODE.createVideo]: 'Create video',
    [WAN22_NODE.saveVideo]: 'Save video'
  }
  if (map[nodeId]) return map[nodeId]
  if (nodeId.startsWith('extra_h_')) return `Apply extra LoRA (high #${nodeId.slice('extra_h_'.length)})`
  if (nodeId.startsWith('extra_l_')) return `Apply extra LoRA (low #${nodeId.slice('extra_l_'.length)})`
  return `Node ${nodeId}`
}

function samplingPhase(nodeId: string | null | undefined): 'high-noise' | 'low-noise' | null {
  if (nodeId === WAN22_NODE.samplerHigh) return 'high-noise'
  if (nodeId === WAN22_NODE.samplerLow) return 'low-noise'
  return null
}

type ComfyWsProgress = {
  close: () => void
}

/**
 * Main-process WebSocket to ComfyUI — required so sampling `progress` events
 * (video steps) reach us. Renderer WS was silently failing.
 */
async function openComfyProgressWs(
  baseUrl: string,
  clientId: string,
  promptIdRef: { current: string },
  liveProgressAt: { current: number },
  onProgress?: (message: string) => void
): Promise<ComfyWsProgress> {
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
        const phase = samplingPhase(currentNode)
        if (phase) {
          push(`Generating video (${phase})…`)
        } else {
          push(`Running: ${describeNode(currentNode)}`)
        }
        return
      }

      if (msg.type === 'progress') {
        const value = Number(data.value)
        const max = Number(data.max)
        if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return
        const step = Math.max(0, Math.floor(value))
        const total = Math.max(1, Math.floor(max))
        // Comfy often reports 0..max; show 1-based when value is 0-based mid-run.
        const displayStep = step <= 0 ? 1 : Math.min(step, total)
        const node = currentNode || data.node || null
        const phase = samplingPhase(node)
        if (phase) {
          push(`Generating video — step ${displayStep}/${total} (${phase})`)
        } else {
          push(`${describeNode(node)} — step ${displayStep}/${total}`)
        }
      }
    } catch {
      /* ignore */
    }
  })

  const connected = await window.api.comfyProgressConnect({ baseUrl, clientId })
  if (!connected.ok) {
    off()
    onProgress(`Progress WS unavailable (${connected.error || 'unknown'}) — elapsed timer only`)
    return {
      close: () => {
        closed = true
        off()
        void window.api.comfyProgressDisconnect()
      }
    }
  }

  return {
    close: () => {
      closed = true
      off()
      void window.api.comfyProgressDisconnect()
    }
  }
}

export async function generateWan22LoopWithComfy(
  params: ComfyWan22LoopParams,
  opts?: {
    signal?: AbortSignal
    baseUrl?: string
    onProgress?: (message: string) => void
  }
): Promise<{ promptId: string; seed: number; videos: ComfyVideoRef[]; length: number }> {
  const baseUrl = (opts?.baseUrl || COMFY_BASE_URL).replace(/\/$/, '')
  const signal = opts?.signal
  const onProgress = opts?.onProgress

  const seed =
    params.seed < 0 ? Math.floor(Math.random() * 1_000_000_000_000) : Math.floor(params.seed)
  const length = framesFromSeconds(params.seconds, params.fps)

  onProgress?.('Building Wan2.2 workflow…')
  const workflow = buildWan22LoopWorkflow({ ...params, seed })
  const cid = clientId()
  const promptIdRef = { current: '' }
  const liveProgressAt = { current: 0 }

  onProgress?.('Connecting ComfyUI progress…')
  const ws = await openComfyProgressWs(baseUrl, cid, promptIdRef, liveProgressAt, onProgress)

  try {
    onProgress?.('Queuing prompt to ComfyUI…')
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
      throw new Error(
        `ComfyUI /prompt failed (${queued.status}): ${queued.error || queued.text || 'unknown'}`
      )
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

    onProgress?.(`Queued — preparing models / encoding (then video steps)`)
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
    return { promptId, seed, videos, length }
  } finally {
    ws.close()
  }
}

