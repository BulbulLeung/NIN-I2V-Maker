/**
 * Wan2.2 Loop workflow API graph (I2V / FLF2V / WanFunInpaint).
 * Mirrors generation path of Wan22 Video(Loop) Settings subgraph —
 * optional Color Match after VAE decode; no Interpolation / Upscale / Mini Meme.
 */

import {
  framesFromSeconds,
  type VideoSaveBitDepth,
  type VideoSaveCodec,
  type VideoSaveFormat,
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
  saveVideo: '18',
  colorMatch: '19'
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
  videoFormat?: VideoSaveFormat
  videoCodec?: VideoSaveCodec
  videoBitDepth?: VideoSaveBitDepth
  videoCrf?: number
  /** Match decoded frames to start image colors (NINI2VColorMatch). */
  useColorMatch?: boolean
}

export interface VideoNodeCaps {
  /** Prefer NIN custom node — direct multi-codec encode from IMAGE frames. */
  hasNinSaveVideo: boolean
  /** NINI2VColorMatch after VAE decode. */
  hasNinColorMatch: boolean
  createHasBitDepth: boolean
  saveHasFormat: boolean
  saveHasCodec: boolean
  saveHasEncoding: boolean
  saveHasCrf: boolean
  /** When true, nested CRF uses codec.encoding / codec.encoding.crf keys. */
  codecIsDynamicCombo: boolean
  codecOptions: string[] | null
  formatOptions: string[] | null
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

function collectInputNames(nodeInfo: Record<string, unknown> | undefined): Set<string> {
  const names = new Set<string>()
  if (!nodeInfo || typeof nodeInfo !== 'object') return names
  const input = nodeInfo.input as Record<string, unknown> | undefined
  if (!input) return names
  for (const group of ['required', 'optional'] as const) {
    const block = input[group]
    if (!block || typeof block !== 'object') continue
    for (const key of Object.keys(block as Record<string, unknown>)) {
      names.add(key)
    }
  }
  return names
}

function extractComboOptions(
  nodeInfo: Record<string, unknown> | undefined,
  inputName: string
): { options: string[] | null; isDynamicCombo: boolean; hasNestedEncoding: boolean; hasNestedCrf: boolean } {
  const empty = {
    options: null as string[] | null,
    isDynamicCombo: false,
    hasNestedEncoding: false,
    hasNestedCrf: false
  }
  if (!nodeInfo || typeof nodeInfo !== 'object') return empty
  const input = nodeInfo.input as Record<string, unknown> | undefined
  if (!input) return empty
  for (const group of ['required', 'optional'] as const) {
    const block = input[group] as Record<string, unknown> | undefined
    const spec = block?.[inputName]
    if (!Array.isArray(spec) || spec.length === 0) continue
    const first = spec[0]
    // Classic COMBO: [["auto","h264",...], {..}]
    if (Array.isArray(first) && first.every((x) => typeof x === 'string')) {
      return {
        options: first as string[],
        isDynamicCombo: false,
        hasNestedEncoding: false,
        hasNestedCrf: false
      }
    }
    // DynamicCombo V3: ["COMFY_DYNAMICCOMBO_V3", { options: [{ key, inputs }, ...] }]
    if (typeof first === 'string' && /DYNAMICCOMBO/i.test(first)) {
      const meta = spec[1] as { options?: { key?: string; inputs?: Record<string, unknown> }[] } | undefined
      const keys =
        meta?.options
          ?.map((o) => (typeof o?.key === 'string' ? o.key : ''))
          .filter(Boolean) || []
      let hasNestedEncoding = false
      let hasNestedCrf = false
      for (const opt of meta?.options || []) {
        const nested = opt.inputs
        if (!nested || typeof nested !== 'object') continue
        for (const section of ['required', 'optional'] as const) {
          const sec = nested[section] as Record<string, unknown> | undefined
          if (!sec) continue
          if (sec.encoding) hasNestedEncoding = true
          if (sec.crf) hasNestedCrf = true
          // Nested DynamicCombo encoding may hold crf under its options
          const encSpec = sec.encoding
          if (Array.isArray(encSpec) && typeof encSpec[0] === 'string' && /DYNAMICCOMBO/i.test(encSpec[0])) {
            hasNestedEncoding = true
            const encMeta = encSpec[1] as { options?: { inputs?: Record<string, unknown> }[] } | undefined
            for (const encOpt of encMeta?.options || []) {
              const encInputs = encOpt.inputs
              if (!encInputs || typeof encInputs !== 'object') continue
              for (const eg of ['required', 'optional'] as const) {
                const es = encInputs[eg] as Record<string, unknown> | undefined
                if (es?.crf) hasNestedCrf = true
              }
            }
          }
        }
      }
      return {
        options: keys.length > 0 ? keys : null,
        isDynamicCombo: true,
        hasNestedEncoding,
        hasNestedCrf
      }
    }
  }
  return empty
}

export async function probeVideoNodeCaps(baseUrl: string): Promise<VideoNodeCaps> {
  const defaults: VideoNodeCaps = {
    hasNinSaveVideo: false,
    hasNinColorMatch: false,
    createHasBitDepth: false,
    saveHasFormat: true,
    saveHasCodec: true,
    saveHasEncoding: false,
    saveHasCrf: false,
    codecIsDynamicCombo: false,
    codecOptions: null,
    formatOptions: null
  }
  try {
    const base = baseUrl.replace(/\/$/, '')
    const [ninRes, colorRes, createRes, saveRes] = await Promise.all([
      comfyHttp(`${base}/object_info/NINI2VSaveVideo`, { timeoutMs: 15_000 }),
      comfyHttp(`${base}/object_info/NINI2VColorMatch`, { timeoutMs: 15_000 }),
      comfyHttp(`${base}/object_info/CreateVideo`, { timeoutMs: 15_000 }),
      comfyHttp(`${base}/object_info/SaveVideo`, { timeoutMs: 15_000 })
    ])
    if (ninRes.ok && ninRes.text) {
      try {
        const parsed = JSON.parse(ninRes.text) as Record<string, unknown>
        if (parsed.NINI2VSaveVideo) {
          defaults.hasNinSaveVideo = true
          const info = parsed.NINI2VSaveVideo as Record<string, unknown>
          const codecInfo = extractComboOptions(info, 'codec')
          const formatInfo = extractComboOptions(info, 'format')
          defaults.codecOptions = codecInfo.options
          defaults.formatOptions = formatInfo.options
        }
      } catch {
        /* ignore */
      }
    }
    if (colorRes.ok && colorRes.text) {
      try {
        const parsed = JSON.parse(colorRes.text) as Record<string, unknown>
        if (parsed.NINI2VColorMatch) defaults.hasNinColorMatch = true
      } catch {
        /* ignore */
      }
    }
    if (createRes.ok && createRes.text) {
      const parsed = JSON.parse(createRes.text) as Record<string, Record<string, unknown>>
      const names = collectInputNames(parsed.CreateVideo)
      defaults.createHasBitDepth = names.has('bit_depth')
    }
    if (!defaults.hasNinSaveVideo && saveRes.ok && saveRes.text) {
      const parsed = JSON.parse(saveRes.text) as Record<string, Record<string, unknown>>
      const info = parsed.SaveVideo
      const names = collectInputNames(info)
      defaults.saveHasFormat = names.has('format') || defaults.saveHasFormat
      defaults.saveHasCodec = names.has('codec') || defaults.saveHasCodec
      const codecInfo = extractComboOptions(info, 'codec')
      const formatInfo = extractComboOptions(info, 'format')
      defaults.codecOptions = codecInfo.options
      defaults.formatOptions = formatInfo.options
      defaults.codecIsDynamicCombo = codecInfo.isDynamicCombo
      defaults.saveHasEncoding =
        names.has('encoding') || names.has('codec.encoding') || codecInfo.hasNestedEncoding
      defaults.saveHasCrf =
        names.has('crf') || names.has('codec.encoding.crf') || codecInfo.hasNestedCrf
    }
  } catch {
    /* use defaults */
  }
  return defaults
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

function pickCodec(p: ComfyWan22LoopParams, caps?: VideoNodeCaps): string {
  let wanted = (p.videoCodec || 'h264').trim() || 'h264'
  if (wanted === 'auto') wanted = 'h264'
  if (caps?.hasNinSaveVideo) {
    return pickFromOptions(wanted, caps.codecOptions, ['h264', 'h265', 'av1', 'vp9', 'prores'])
  }
  return pickFromOptions(wanted, caps?.codecOptions ?? null, ['h264', 'auto'])
}

function pickFormat(p: ComfyWan22LoopParams, caps?: VideoNodeCaps): string {
  const wanted = (p.videoFormat || 'auto').trim() || 'auto'
  if (caps?.hasNinSaveVideo) {
    return pickFromOptions(wanted, caps.formatOptions, ['auto', 'mp4', 'webm', 'mkv'])
  }
  return pickFromOptions(wanted, caps?.formatOptions ?? null, ['auto', 'mp4'])
}

function imagesSourceNode(p: ComfyWan22LoopParams): string {
  return p.useColorMatch ? WAN22_NODE.colorMatch : WAN22_NODE.vaeDecode
}

function buildNinSaveVideoInputs(p: ComfyWan22LoopParams, caps?: VideoNodeCaps): Record<string, unknown> {
  const format = pickFormat(p, caps)
  const codec = pickCodec(p, caps)
  const crf = Math.min(63, Math.max(0, Math.round(p.videoCrf ?? 23)))
  return {
    images: [imagesSourceNode(p), 0],
    fps: p.fps,
    filename_prefix: p.savePrefix || prefixForMode(p.mode),
    format,
    codec,
    bit_depth: p.videoBitDepth === 10 ? 10 : 8,
    crf
  }
}

function buildCreateVideoInputs(
  p: ComfyWan22LoopParams,
  caps?: VideoNodeCaps
): Record<string, unknown> {
  const inputs: Record<string, unknown> = {
    images: [imagesSourceNode(p), 0],
    fps: p.fps
  }
  if (caps?.createHasBitDepth) {
    inputs.bit_depth = p.videoBitDepth === 10 ? 10 : 8
  }
  return inputs
}

function buildSaveVideoInputs(
  p: ComfyWan22LoopParams,
  caps?: VideoNodeCaps
): Record<string, unknown> {
  const format = pickFormat(p, caps)
  const codec = pickCodec(p, caps)
  const crf = Math.min(51, Math.max(0, Math.round(p.videoCrf ?? 23)))
  const inputs: Record<string, unknown> = {
    video: [WAN22_NODE.createVideo, 0],
    filename_prefix: p.savePrefix || prefixForMode(p.mode)
  }
  if (!caps || caps.saveHasFormat) inputs.format = format
  if (!caps || caps.saveHasCodec) inputs.codec = codec

  const wantCrf = codec === 'h264'
  if (wantCrf && caps && (caps.saveHasCrf || caps.saveHasEncoding)) {
    if (caps.codecIsDynamicCombo) {
      inputs['codec.encoding'] = 're-encode'
      inputs['codec.encoding.crf'] = crf
    } else {
      if (caps.saveHasEncoding) inputs.encoding = 're-encode'
      inputs.crf = crf
    }
  }
  return inputs
}

/**
 * Build API prompt graph aligned with Wan22 Loop generation (dual UNET + dual KSampler).
 * Optional Color Match after VAE decode. Interp / upscale / mini meme remain omitted.
 */
export function buildWan22LoopWorkflow(
  p: ComfyWan22LoopParams,
  caps?: VideoNodeCaps
): Record<string, unknown> {
  const legacyStrength = p.loraStrength ?? 0.8
  const highStrength = p.loraHighStrength ?? legacyStrength
  const lowStrength = p.loraLowStrength ?? legacyStrength
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
    }
  }

  if (p.useColorMatch) {
    graph[WAN22_NODE.colorMatch] = {
      class_type: 'NINI2VColorMatch',
      inputs: {
        image_ref: [WAN22_NODE.startImage, 0],
        image_target: [WAN22_NODE.vaeDecode, 0],
        strength: 1.0
      }
    }
  }

  if (caps?.hasNinSaveVideo) {
    graph[WAN22_NODE.saveVideo] = {
      class_type: 'NINI2VSaveVideo',
      inputs: buildNinSaveVideoInputs(p, caps)
    }
  } else {
    graph[WAN22_NODE.createVideo] = {
      class_type: 'CreateVideo',
      inputs: buildCreateVideoInputs(p, caps)
    }
    graph[WAN22_NODE.saveVideo] = {
      class_type: 'SaveVideo',
      inputs: buildSaveVideoInputs(p, caps)
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

  const speedHighName = (p.loraHighName || '').trim()
  const speedLowName = (p.loraLowName || '').trim()
  const speedHigh = speedHighName ? { name: speedHighName, strength: highStrength } : null
  const speedLow = speedLowName ? { name: speedLowName, strength: lowStrength } : null

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
            const statusFull = entry.status as Record<string, unknown> | undefined
            const messages = statusFull?.messages
            let exceptionMessage = ''
            let nodeId = ''
            let nodeType = ''
            if (Array.isArray(messages)) {
              for (const m of messages) {
                if (!Array.isArray(m) || m[0] !== 'execution_error') continue
                const detail = m[1] as Record<string, unknown> | undefined
                if (!detail) continue
                exceptionMessage = String(detail.exception_message || detail.message || '')
                nodeId = String(detail.node_id ?? '')
                nodeType = String(detail.node_type ?? '')
              }
            }
            const detail =
              exceptionMessage || nodeType
                ? ` (${nodeType || nodeId}: ${exceptionMessage || 'unknown'})`
                : ''
            throw new Error(`ComfyUI reported an error while generating video${detail}`)
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
    [WAN22_NODE.colorMatch]: 'Color match to start image',
    [WAN22_NODE.createVideo]: 'Create video',
    [WAN22_NODE.saveVideo]: 'Save video (direct encode)'
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
  const caps = await probeVideoNodeCaps(baseUrl)
  if (!caps.hasNinSaveVideo) {
    throw new Error(
      'NINI2VSaveVideo custom node not loaded. Stop ComfyUI and Start again so NIN custom nodes can install (direct H265/AV1/VP9/ProRes encode).'
    )
  }
  if (params.useColorMatch && !caps.hasNinColorMatch) {
    throw new Error(
      'NINI2VColorMatch custom node not loaded. Stop ComfyUI and Start again so NIN custom nodes can install (Color Match).'
    )
  }
  const workflow = buildWan22LoopWorkflow({ ...params, seed }, caps)
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

