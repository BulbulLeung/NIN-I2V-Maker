/**
 * Face Detailer post-process: load video → YOLO SEGS → crop/upscale faces →
 * Wan light denoise (Low DiT) → SEGSPaste → NINI2VSaveVideo.
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

export const FACE_NODE = {
  loadVideo: '1',
  unetLow: '2',
  clip: '3',
  vae: '4',
  shiftLow: '5',
  positive: '6',
  negative: '7',
  bboxDetector: '8',
  detect: '9',
  orderedFilter: '10',
  rangeFilter: '11',
  setDefaultSegs: '12',
  decompose: '13',
  fromSeg: '14',
  cropSize: '15',
  upscaleModel: '16',
  upscale: '17',
  faceSize: '18',
  startFrame: '19',
  wanCond: '20',
  encode: '21',
  sampler: '22',
  decode: '23',
  scaleBack: '24',
  videoSize: '29',
  alignFaces: '30',
  alignedFaceSize: '31',
  alignVideo: '32',
  editSeg: '25',
  assemble: '26',
  paste: '27',
  saveVideo: '28',
  /** Speed LoRA (low) after ModelSamplingSD3 — same as Video Gen. */
  loraLow: '33',
  /** Guard empty SEGS so ImpactFrom_SEG_ELT is not executed with no items. */
  hasFaces: '34',
  pickOutput: '35'
} as const

export interface ComfyFaceDetailerParams {
  uploadedVideoName: string
  uploadedVideoSubfolder?: string
  lowDitName: string
  /** Speed / Lightning LoRA basename for Low DiT (optional). */
  loraLowName?: string
  loraLowStrength?: number
  vaeName: string
  clipName: string
  bboxModelName: string
  upscaleModelName?: string
  bboxThreshold: number
  cropFactor: number
  takeCount: number
  minFaceWidth: number
  feather: number
  steps: number
  startAtStep: number
  endAtStep: number
  cfg: number
  sampler: string
  scheduler: string
  positive: string
  negative: string
  seed: number
  shift: number
  fps: number
  savePrefix?: string
  videoFormat?: VideoSaveFormat
  videoCodec?: VideoSaveCodec
  videoBitDepth?: VideoSaveBitDepth
  videoCrf?: number
}

export interface FaceDetailerNodeCaps {
  hasNinLoadVideo: boolean
  hasNinSaveVideo: boolean
  hasUltralytics: boolean
  hasSimpleDetector: boolean
  hasOrderedFilter: boolean
  hasRangeFilter: boolean
  hasSetDefaultSegs: boolean
  hasDecompose: boolean
  hasFromSeg: boolean
  hasEditSeg: boolean
  hasAssemble: boolean
  hasSegsPaste: boolean
  hasGetImageSize: boolean
  hasImageFromBatch: boolean
  hasUpscaleModelLoader: boolean
  hasImageUpscaleWithModel: boolean
  hasWanImageToVideo: boolean
  hasIsNotEmptySegs: boolean
  hasConditionalBranch: boolean
  bboxModelOptions: string[]
  videoCaps: VideoNodeCaps
}

function clientId(): string {
  return `i2vmaker-face-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
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
  if (Array.isArray(first)) {
    return first.filter((x): x is string => typeof x === 'string')
  }
  if (first === 'COMBO' && spec[1] && typeof spec[1] === 'object') {
    const opts = (spec[1] as { options?: unknown }).options
    if (Array.isArray(opts)) {
      return opts.filter((x): x is string => typeof x === 'string')
    }
  }
  return []
}

export async function probeFaceDetailerNodeCaps(baseUrl: string): Promise<FaceDetailerNodeCaps> {
  const base = baseUrl.replace(/\/$/, '')
  const videoCaps = await probeVideoNodeCaps(base)
  const caps: FaceDetailerNodeCaps = {
    hasNinLoadVideo: false,
    hasNinSaveVideo: videoCaps.hasNinSaveVideo,
    hasUltralytics: false,
    hasSimpleDetector: false,
    hasOrderedFilter: false,
    hasRangeFilter: false,
    hasSetDefaultSegs: false,
    hasDecompose: false,
    hasFromSeg: false,
    hasEditSeg: false,
    hasAssemble: false,
    hasSegsPaste: false,
    hasGetImageSize: false,
    hasImageFromBatch: false,
    hasUpscaleModelLoader: false,
    hasImageUpscaleWithModel: false,
    hasWanImageToVideo: false,
    hasIsNotEmptySegs: false,
    hasConditionalBranch: false,
    bboxModelOptions: [],
    videoCaps
  }
  const names = [
    'NINI2VLoadVideo',
    'UltralyticsDetectorProvider',
    'ImpactSimpleDetectorSEGS_for_AD',
    'ImpactSEGSOrderedFilter',
    'ImpactSEGSRangeFilter',
    'SetDefaultImageForSEGS',
    'ImpactDecomposeSEGS',
    'ImpactFrom_SEG_ELT',
    'ImpactEdit_SEG_ELT',
    'ImpactAssembleSEGS',
    'SEGSPaste',
    'GetImageSize',
    'ImageFromBatch',
    'UpscaleModelLoader',
    'ImageUpscaleWithModel',
    'WanImageToVideo',
    'ImpactIsNotEmptySEGS',
    'ImpactConditionalBranch'
  ] as const
  try {
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
        const n = names[i]
        if (n === 'NINI2VLoadVideo') caps.hasNinLoadVideo = true
        if (n === 'UltralyticsDetectorProvider') {
          caps.hasUltralytics = true
          caps.bboxModelOptions = collectComboOptions(info, 'model_name')
        }
        if (n === 'ImpactSimpleDetectorSEGS_for_AD') caps.hasSimpleDetector = true
        if (n === 'ImpactSEGSOrderedFilter') caps.hasOrderedFilter = true
        if (n === 'ImpactSEGSRangeFilter') caps.hasRangeFilter = true
        if (n === 'SetDefaultImageForSEGS') caps.hasSetDefaultSegs = true
        if (n === 'ImpactDecomposeSEGS') caps.hasDecompose = true
        if (n === 'ImpactFrom_SEG_ELT') caps.hasFromSeg = true
        if (n === 'ImpactEdit_SEG_ELT') caps.hasEditSeg = true
        if (n === 'ImpactAssembleSEGS') caps.hasAssemble = true
        if (n === 'SEGSPaste') caps.hasSegsPaste = true
        if (n === 'GetImageSize') caps.hasGetImageSize = true
        if (n === 'ImageFromBatch') caps.hasImageFromBatch = true
        if (n === 'UpscaleModelLoader') caps.hasUpscaleModelLoader = true
        if (n === 'ImageUpscaleWithModel') caps.hasImageUpscaleWithModel = true
        if (n === 'WanImageToVideo') caps.hasWanImageToVideo = true
        if (n === 'ImpactIsNotEmptySEGS') caps.hasIsNotEmptySegs = true
        if (n === 'ImpactConditionalBranch') caps.hasConditionalBranch = true
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

function pickCodec(p: ComfyFaceDetailerParams, caps: VideoNodeCaps): string {
  let wanted = (p.videoCodec || 'h264').trim() || 'h264'
  if (wanted === 'auto') wanted = 'h264'
  return pickFromOptions(wanted, caps.codecOptions, ['h264', 'h265', 'av1', 'vp9', 'prores'])
}

function pickFormat(p: ComfyFaceDetailerParams, caps: VideoNodeCaps): string {
  const wanted = (p.videoFormat || 'auto').trim() || 'auto'
  return pickFromOptions(wanted, caps.formatOptions, ['auto', 'mp4', 'webm', 'mkv'])
}

function pickBboxModel(p: ComfyFaceDetailerParams, caps: FaceDetailerNodeCaps): string {
  const wanted = (p.bboxModelName || '').trim()
  const options = caps.bboxModelOptions
  if (wanted && options.includes(wanted)) return wanted
  if (wanted && options.length === 0) return wanted
  const anime = options.find((n) => /face/i.test(n) && /anime|99coins/i.test(n))
  if (anime) return anime
  const anyFace = options.find((n) => /face/i.test(n))
  if (anyFace) return anyFace
  if (options.length > 0) return options[0]
  return wanted || 'segm/99coins_anime_girl_face_m_seg.pt'
}

export function buildFaceDetailerWorkflow(
  p: ComfyFaceDetailerParams,
  caps: FaceDetailerNodeCaps
): Record<string, unknown> {
  const seed =
    p.seed < 0 ? Math.floor(Math.random() * 1_000_000_000_000) : Math.floor(p.seed)
  const steps = Math.max(1, Math.floor(p.steps))
  // Light denoise: end is always Steps; start is the high/skip boundary (0 … steps−1).
  const startAt = Math.max(0, Math.min(steps - 1, Math.floor(p.startAtStep)))
  const endAt = steps
  const doFaceUpscale = Boolean((p.upscaleModelName || '').trim())
  const bboxModel = pickBboxModel(p, caps)

  const graph: Record<string, unknown> = {
    [FACE_NODE.loadVideo]: {
      class_type: 'NINI2VLoadVideo',
      inputs: {
        video: videoRef(p.uploadedVideoName, p.uploadedVideoSubfolder)
      }
    },
    [FACE_NODE.unetLow]: {
      class_type: 'UNETLoader',
      inputs: {
        unet_name: p.lowDitName,
        weight_dtype: 'default'
      }
    },
    [FACE_NODE.clip]: {
      class_type: 'CLIPLoader',
      inputs: {
        clip_name: p.clipName,
        type: 'wan',
        device: 'default'
      }
    },
    [FACE_NODE.vae]: {
      class_type: 'VAELoader',
      inputs: {
        vae_name: p.vaeName
      }
    },
    [FACE_NODE.shiftLow]: {
      class_type: 'ModelSamplingSD3',
      inputs: {
        model: [FACE_NODE.unetLow, 0],
        shift: p.shift
      }
    },
    [FACE_NODE.positive]: {
      class_type: 'CLIPTextEncode',
      inputs: {
        text: p.positive || '4k,',
        clip: [FACE_NODE.clip, 0]
      }
    },
    [FACE_NODE.negative]: {
      class_type: 'CLIPTextEncode',
      inputs: {
        text: p.negative || '',
        clip: [FACE_NODE.clip, 0]
      }
    },
    [FACE_NODE.bboxDetector]: {
      class_type: 'UltralyticsDetectorProvider',
      inputs: {
        model_name: bboxModel
      }
    },
    [FACE_NODE.detect]: {
      class_type: 'ImpactSimpleDetectorSEGS_for_AD',
      inputs: {
        bbox_detector: [FACE_NODE.bboxDetector, 0],
        image_frames: [FACE_NODE.loadVideo, 0],
        bbox_threshold: p.bboxThreshold,
        bbox_dilation: 0,
        crop_factor: p.cropFactor,
        drop_size: 10,
        sub_threshold: 0.5,
        sub_dilation: 0,
        sub_bbox_expansion: 0,
        sam_mask_hint_threshold: 0.7,
        masking_mode: 'Pivot SEGS',
        segs_pivot: 'Combined mask'
      }
    },
    [FACE_NODE.orderedFilter]: {
      class_type: 'ImpactSEGSOrderedFilter',
      inputs: {
        segs: [FACE_NODE.detect, 0],
        target: 'area(=w*h)',
        order: true,
        take_start: 0,
        take_count: Math.max(1, Math.floor(p.takeCount))
      }
    },
    [FACE_NODE.rangeFilter]: {
      class_type: 'ImpactSEGSRangeFilter',
      inputs: {
        segs: [FACE_NODE.orderedFilter, 0],
        target: 'width',
        mode: true,
        min_value: Math.max(8, Math.floor(p.minFaceWidth)),
        max_value: 10000
      }
    },
    [FACE_NODE.setDefaultSegs]: {
      class_type: 'SetDefaultImageForSEGS',
      inputs: {
        segs: [FACE_NODE.rangeFilter, 0],
        image: [FACE_NODE.loadVideo, 0],
        override: true
      }
    },
    [FACE_NODE.decompose]: {
      class_type: 'ImpactDecomposeSEGS',
      inputs: {
        segs: [FACE_NODE.setDefaultSegs, 0]
      }
    },
    [FACE_NODE.fromSeg]: {
      class_type: 'ImpactFrom_SEG_ELT',
      inputs: {
        seg_elt: [FACE_NODE.decompose, 1]
      }
    },
    [FACE_NODE.cropSize]: {
      class_type: 'GetImageSize',
      inputs: {
        image: [FACE_NODE.fromSeg, 1]
      }
    }
  }

  let faceImages: [string, number] = [FACE_NODE.fromSeg, 1]

  if (doFaceUpscale) {
    graph[FACE_NODE.upscaleModel] = {
      class_type: 'UpscaleModelLoader',
      inputs: {
        model_name: (p.upscaleModelName || '').trim()
      }
    }
    graph[FACE_NODE.upscale] = {
      class_type: 'ImageUpscaleWithModel',
      inputs: {
        upscale_model: [FACE_NODE.upscaleModel, 0],
        image: faceImages
      }
    }
    faceImages = [FACE_NODE.upscale, 0]
  }

  graph[FACE_NODE.faceSize] = {
    class_type: 'GetImageSize',
    inputs: {
      image: faceImages
    }
  }

  const startImageRef: [string, number] = caps.hasImageFromBatch
    ? [FACE_NODE.startFrame, 0]
    : faceImages

  if (caps.hasImageFromBatch) {
    graph[FACE_NODE.startFrame] = {
      class_type: 'ImageFromBatch',
      inputs: {
        image: faceImages,
        batch_index: 0,
        length: 1
      }
    }
  }

  graph[FACE_NODE.wanCond] = {
    class_type: 'WanImageToVideo',
    inputs: {
      positive: [FACE_NODE.positive, 0],
      negative: [FACE_NODE.negative, 0],
      vae: [FACE_NODE.vae, 0],
      start_image: startImageRef,
      width: [FACE_NODE.faceSize, 0],
      height: [FACE_NODE.faceSize, 1],
      length: [FACE_NODE.faceSize, 2],
      batch_size: 1
    }
  }

  graph[FACE_NODE.encode] = {
    class_type: 'VAEEncode',
    inputs: {
      pixels: faceImages,
      vae: [FACE_NODE.vae, 0]
    }
  }

  // Speed LoRA (low) after ModelSamplingSD3 — same order as Video Gen / Wan22 loop.
  let modelTip: [string, number] = [FACE_NODE.shiftLow, 0]
  const speedLowName = (p.loraLowName || '').trim()
  if (speedLowName) {
    const strength =
      typeof p.loraLowStrength === 'number' && Number.isFinite(p.loraLowStrength)
        ? Math.max(0, Math.min(5, p.loraLowStrength))
        : 0.8
    graph[FACE_NODE.loraLow] = {
      class_type: 'LoraLoaderModelOnly',
      inputs: {
        model: [FACE_NODE.shiftLow, 0],
        lora_name: speedLowName,
        strength_model: strength
      }
    }
    modelTip = [FACE_NODE.loraLow, 0]
  }

  graph[FACE_NODE.sampler] = {
    class_type: 'KSamplerAdvanced',
    inputs: {
      model: modelTip,
      positive: [FACE_NODE.wanCond, 0],
      negative: [FACE_NODE.wanCond, 1],
      latent_image: [FACE_NODE.encode, 0],
      add_noise: 'enable',
      noise_seed: seed,
      steps,
      cfg: p.cfg,
      sampler_name: p.sampler || 'euler_ancestral',
      scheduler: p.scheduler || 'sgm_uniform',
      start_at_step: startAt,
      end_at_step: endAt,
      return_with_leftover_noise: 'disable'
    }
  }

  graph[FACE_NODE.decode] = {
    class_type: 'VAEDecode',
    inputs: {
      samples: [FACE_NODE.sampler, 0],
      vae: [FACE_NODE.vae, 0]
    }
  }

  graph[FACE_NODE.scaleBack] = {
    class_type: 'ImageScale',
    inputs: {
      image: [FACE_NODE.decode, 0],
      width: [FACE_NODE.cropSize, 0],
      height: [FACE_NODE.cropSize, 1],
      upscale_method: 'lanczos',
      crop: 'disabled'
    }
  }

  // Wan decode frame count can differ from the source video (e.g. 4n+1).
  // SEGSPaste indexes cropped faces by video frame — align both to the same length.
  graph[FACE_NODE.videoSize] = {
    class_type: 'GetImageSize',
    inputs: {
      image: [FACE_NODE.loadVideo, 0]
    }
  }

  let refinedFaces: [string, number] = [FACE_NODE.scaleBack, 0]
  let pasteVideo: [string, number] = [FACE_NODE.loadVideo, 0]

  if (caps.hasImageFromBatch) {
    graph[FACE_NODE.alignFaces] = {
      class_type: 'ImageFromBatch',
      inputs: {
        image: [FACE_NODE.scaleBack, 0],
        batch_index: 0,
        length: [FACE_NODE.videoSize, 2]
      }
    }
    graph[FACE_NODE.alignedFaceSize] = {
      class_type: 'GetImageSize',
      inputs: {
        image: [FACE_NODE.alignFaces, 0]
      }
    }
    graph[FACE_NODE.alignVideo] = {
      class_type: 'ImageFromBatch',
      inputs: {
        image: [FACE_NODE.loadVideo, 0],
        batch_index: 0,
        length: [FACE_NODE.alignedFaceSize, 2]
      }
    }
    refinedFaces = [FACE_NODE.alignFaces, 0]
    pasteVideo = [FACE_NODE.alignVideo, 0]
  }

  graph[FACE_NODE.editSeg] = {
    class_type: 'ImpactEdit_SEG_ELT',
    inputs: {
      seg_elt: [FACE_NODE.fromSeg, 0],
      cropped_image_opt: refinedFaces,
      cropped_mask_opt: [FACE_NODE.fromSeg, 2]
    }
  }

  graph[FACE_NODE.assemble] = {
    class_type: 'ImpactAssembleSEGS',
    inputs: {
      seg_header: [FACE_NODE.decompose, 0],
      seg_elt: [FACE_NODE.editSeg, 0]
    }
  }

  graph[FACE_NODE.paste] = {
    class_type: 'SEGSPaste',
    inputs: {
      image: pasteVideo,
      segs: [FACE_NODE.assemble, 0],
      feather: Math.max(0, Math.floor(p.feather)),
      alpha: 255
    }
  }

  // Empty SEGS → ImpactFrom_SEG_ELT crashes (missing seg_elt). Lazy-branch so the
  // refine path is skipped and we save the original frames instead.
  let saveImages: [string, number] = [FACE_NODE.paste, 0]
  if (caps.hasIsNotEmptySegs && caps.hasConditionalBranch) {
    graph[FACE_NODE.hasFaces] = {
      class_type: 'ImpactIsNotEmptySEGS',
      inputs: {
        segs: [FACE_NODE.setDefaultSegs, 0]
      }
    }
    graph[FACE_NODE.pickOutput] = {
      class_type: 'ImpactConditionalBranch',
      inputs: {
        cond: [FACE_NODE.hasFaces, 0],
        tt_value: [FACE_NODE.paste, 0],
        ff_value: [FACE_NODE.loadVideo, 0]
      }
    }
    saveImages = [FACE_NODE.pickOutput, 0]
  }

  const format = pickFormat(p, caps.videoCaps)
  const codec = pickCodec(p, caps.videoCaps)
  const crf = Math.min(63, Math.max(0, Math.round(p.videoCrf ?? 23)))
  graph[FACE_NODE.saveVideo] = {
    class_type: 'NINI2VSaveVideo',
    inputs: {
      images: saveImages,
      fps: Math.max(1, p.fps),
      filename_prefix: p.savePrefix || 'face/Wan2.2',
      filename_suffix: '_face',
      format,
      codec,
      bit_depth: p.videoBitDepth === 10 ? 10 : 8,
      crf
    }
  }

  return graph
}

function formatFaceDetailerExecError(nodeType: string, exceptionMessage: string): string {
  const nt = (nodeType || '').trim()
  const msg = (exceptionMessage || '').trim()
  if (
    /ImpactFrom_SEG_ELT/i.test(nt) &&
    /missing .+ argument:\s*'?seg_elt'?/i.test(msg)
  ) {
    return (
      'No faces left after detection/filtering (empty SEGS). ' +
      'Lower detector threshold or Min face detect size, or try another YOLO face model.'
    )
  }
  if (nt || msg) return `${nt || 'ComfyUI'}: ${msg || 'unknown'}`
  return 'unknown'
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
    if (signal?.aborted) throw new Error('Face Detailer cancelled')
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
            const detail = formatFaceDetailerExecError(nodeType, exceptionMessage)
            throw new Error(
              detail === 'unknown'
                ? 'ComfyUI reported an error while face detailing'
                : `ComfyUI reported an error while face detailing (${detail})`
            )
          }
          const statusStrOk = statusStr === 'success'
          const completed = entry.status?.completed === true || statusStrOk
          const outputs = entry.outputs
          const hasOutputs =
            Boolean(outputs) &&
            typeof outputs === 'object' &&
            Object.keys(outputs as object).length > 0
          if (completed || (hasOutputs && entry.status?.completed !== false)) {
            return entry as unknown as Record<string, unknown>
          }
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('ComfyUI')) throw err
      }
    }
    const liveAt = liveProgressAt?.current ?? 0
    if (liveAt < start) {
      const elapsedSec = Math.floor((Date.now() - start) / 1000)
      report(`Face Detailer… ${elapsedSec}s`)
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
    [FACE_NODE.loadVideo]: 'Load video',
    [FACE_NODE.unetLow]: 'Load Low DiT',
    [FACE_NODE.loraLow]: 'Apply Speed LoRA (low)',
    [FACE_NODE.clip]: 'Load CLIP',
    [FACE_NODE.vae]: 'Load VAE',
    [FACE_NODE.bboxDetector]: 'Load face detector',
    [FACE_NODE.detect]: 'Detect faces',
    [FACE_NODE.orderedFilter]: 'Filter faces',
    [FACE_NODE.rangeFilter]: 'Filter face size',
    [FACE_NODE.fromSeg]: 'Crop faces',
    [FACE_NODE.upscale]: 'Upscale face crops',
    [FACE_NODE.wanCond]: 'Wan face conditioning',
    [FACE_NODE.encode]: 'Encode faces',
    [FACE_NODE.sampler]: 'Refine faces',
    [FACE_NODE.decode]: 'Decode faces',
    [FACE_NODE.paste]: 'Paste faces',
    [FACE_NODE.hasFaces]: 'Check faces found',
    [FACE_NODE.pickOutput]: 'Pick face or original',
    [FACE_NODE.saveVideo]: 'Save video'
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

export async function generateFaceDetailerWithComfy(
  params: ComfyFaceDetailerParams,
  opts?: {
    signal?: AbortSignal
    baseUrl?: string
    onProgress?: (message: string) => void
  }
): Promise<{ promptId: string; videos: ComfyVideoRef[] }> {
  const baseUrl = (opts?.baseUrl || COMFY_BASE_URL).replace(/\/$/, '')
  const signal = opts?.signal
  const onProgress = opts?.onProgress

  if (!(params.lowDitName || '').trim()) {
    throw new Error('Set Low DiT model in Settings → ComfyUI')
  }
  if (!(params.vaeName || '').trim() || !(params.clipName || '').trim()) {
    throw new Error('Set VAE and CLIP in Settings → ComfyUI')
  }

  onProgress?.('Probing ComfyUI Face Detailer nodes…')
  const caps = await probeFaceDetailerNodeCaps(baseUrl)
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
  const impactMissing: string[] = []
  if (!caps.hasUltralytics) impactMissing.push('UltralyticsDetectorProvider')
  if (!caps.hasSimpleDetector) impactMissing.push('ImpactSimpleDetectorSEGS_for_AD')
  if (!caps.hasOrderedFilter) impactMissing.push('ImpactSEGSOrderedFilter')
  if (!caps.hasRangeFilter) impactMissing.push('ImpactSEGSRangeFilter')
  if (!caps.hasSetDefaultSegs) impactMissing.push('SetDefaultImageForSEGS')
  if (!caps.hasDecompose) impactMissing.push('ImpactDecomposeSEGS')
  if (!caps.hasFromSeg) impactMissing.push('ImpactFrom_SEG_ELT')
  if (!caps.hasEditSeg) impactMissing.push('ImpactEdit_SEG_ELT')
  if (!caps.hasAssemble) impactMissing.push('ImpactAssembleSEGS')
  if (!caps.hasSegsPaste) impactMissing.push('SEGSPaste')
  if (impactMissing.length > 0) {
    throw new Error(
      `Impact Pack face nodes missing: ${impactMissing.join(', ')}. ` +
        'Install comfyui-impact-pack + comfyui-impact-subpack into this ComfyUI custom_nodes ' +
        '(and models/ultralytics face weights), then Stop and Start ComfyUI in the app.'
    )
  }
  if (!caps.hasGetImageSize) {
    throw new Error(
      'GetImageSize node not found. Update ComfyUI core and restart.'
    )
  }
  if (!caps.hasImageFromBatch) {
    throw new Error(
      'ImageFromBatch node not found. Update ComfyUI core and restart (needed to align face/video frame counts).'
    )
  }
  if (!caps.hasWanImageToVideo) {
    throw new Error('WanImageToVideo not found. Update ComfyUI Wan nodes and restart.')
  }
  if ((params.upscaleModelName || '').trim()) {
    if (!caps.hasUpscaleModelLoader || !caps.hasImageUpscaleWithModel) {
      throw new Error(
        'UpscaleModelLoader / ImageUpscaleWithModel not found. Clear face upscale model, or update ComfyUI and restart.'
      )
    }
  }

  onProgress?.('Building Face Detailer workflow…')
  const workflow = buildFaceDetailerWorkflow(params, caps)
  const cid = clientId()
  const promptIdRef = { current: '' }
  const liveProgressAt = { current: 0 }

  onProgress?.('Connecting ComfyUI progress…')
  const ws = await openComfyProgressWs(baseUrl, cid, promptIdRef, liveProgressAt, onProgress)

  try {
    onProgress?.('Queuing Face Detailer prompt…')
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
        const parsed = JSON.parse(queued.text || '{}') as {
          error?: { message?: string; type?: string }
          node_errors?: Record<
            string,
            { class_type?: string; errors?: { details?: string; message?: string }[] }
          >
        }
        const parts: string[] = []
        if (parsed.error?.message) parts.push(parsed.error.message)
        if (parsed.node_errors) {
          for (const [nid, ne] of Object.entries(parsed.node_errors)) {
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

    onProgress?.('Queued — Face Detailer…')
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
