import { join } from '../utils/pathJoin'
import {
  DEFAULT_RESOLUTION_PRESET,
  isResolutionPreset
} from '../utils/wanResolution'

export type ActiveView = 'prompt' | 'videoGen' | 'upscale' | 'faceDetailer'
export type VideoGenPanel = 'i2v' | 'flf2v' | 'loop'
export type FlfMode = 'flf2v' | 'wanfun_inpaint'
export type Wan22VideoMode = 'i2v' | 'flf2v' | 'wanfun_inpaint'

/** Comfy paths shared by I2V and FLF2V panels + Settings. */
export interface SharedComfyDraft {
  comfyUiBatPath: string
  /** Folder containing Wan DiT / UNET safetensors; High/Low pick from this list. */
  ditModelFolder: string
  highDitPath: string
  lowDitPath: string
  /** Folder for Speed / Lightning LoRAs (high + low dropdowns). */
  speedLoraFolder: string
  /** Folder for extra style / character LoRAs (addable list). */
  wan22LoraFolder: string
  /** Folder for UpscaleModelLoader weights (Upscale page dropdown). */
  upscaleModelFolder: string
  /** Folder for FrameInterpolationModelLoader weights (Upscale page dropdown). */
  frameInterpModelFolder: string
  vaePath: string
  clipPath: string
  outputFolder: string
  /** SaveVideo container: auto / mp4 / webm / mkv */
  videoFormat: VideoSaveFormat
  /** SaveVideo codec: auto / h264 / h265 / av1 / vp9 / prores */
  videoCodec: VideoSaveCodec
  /** CreateVideo bit_depth (8 or 10). */
  videoBitDepth: VideoSaveBitDepth
  /** Encoder CRF — lower = higher quality / larger file (typical 0–51). */
  videoCrf: number
  /** Launch ComfyUI with --use-sage-attention when true. */
  useSageAttention: boolean
  /**
   * After VAE decode, match video frame colors to the start image (Reinhard LAB).
   * Reduces VAE color shift vs the source still.
   */
  useColorMatch: boolean
}

/** Upscale / Interpolation panel draft (independent of I2V generate params). */
export interface UpscaleGenerateDraft {
  selectedVideoPath: string
  upscaleModelPath: string
  /** Frame interpolation model path (basename used by FrameInterpolationModelLoader). */
  interpolationModelPath: string
  /** Target resolution preset (same options as generate). Empty / Off = skip upscale resize. */
  resolutionPreset: string
  /** 1 = skip interpolation */
  interpolationScale: number
  /** After upscale + interpolation, drop the last frame before save. */
  removeLastFrame: boolean
}

/** Face Detailer post-process panel (Impact SEGS + Wan light denoise). */
export interface FaceDetailerDraft {
  selectedVideoPath: string
  /** Low noise Wan DiT for face refine (independent of Video Gen). */
  lowDitPath: string
  /** Speed / Lightning LoRA for Low DiT (same fields as Video Gen low). */
  loraLowPath: string
  loraLowStrength: number
  loraLowEnabled: boolean
  /** UltralyticsDetectorProvider model_name (e.g. bbox/….pt). */
  bboxModelName: string
  /** Optional face-crop upscale (UpscaleModelLoader basename path). */
  upscaleModelPath: string
  bboxThreshold: number
  cropFactor: number
  takeCount: number
  minFaceWidth: number
  feather: number
  steps: number
  /** KSamplerAdvanced start_at_step (high / skip). End is always `steps`. */
  startAtStep: number
  /** Always kept equal to `steps` (locked end_at_step). */
  endAtStep: number
  cfg: number
  sampler: string
  scheduler: string
  positive: string
  negative: string
  seed: number
  /** ModelSamplingSD3 shift for Low DiT. */
  shift: number
}

export type VideoSaveFormat = 'auto' | 'mp4' | 'webm' | 'mkv'
export type VideoSaveCodec = 'auto' | 'h264' | 'h265' | 'av1' | 'vp9' | 'prores'
export type VideoSaveBitDepth = 8 | 10

export const VIDEO_SAVE_FORMAT_OPTIONS: { value: VideoSaveFormat; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'mp4', label: 'MP4' },
  { value: 'webm', label: 'WebM' },
  { value: 'mkv', label: 'MKV' }
]

export const VIDEO_SAVE_CODEC_OPTIONS: { value: VideoSaveCodec; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'h264', label: 'H264' },
  { value: 'h265', label: 'H265 (HEVC)' },
  { value: 'av1', label: 'AV1' },
  { value: 'vp9', label: 'VP9' },
  { value: 'prores', label: 'ProRes' }
]

export const VIDEO_SAVE_BIT_DEPTH_OPTIONS: { value: VideoSaveBitDepth; label: string }[] = [
  { value: 8, label: '8bit' },
  { value: 10, label: '10bit' }
]

export const DEFAULT_VIDEO_CRF = 23
export const VIDEO_CRF_MIN = 0
export const VIDEO_CRF_MAX = 51

export function isVideoSaveFormat(value: string): value is VideoSaveFormat {
  return VIDEO_SAVE_FORMAT_OPTIONS.some((o) => o.value === value)
}

export function isVideoSaveCodec(value: string): value is VideoSaveCodec {
  return VIDEO_SAVE_CODEC_OPTIONS.some((o) => o.value === value)
}

export function normalizeVideoBitDepth(raw: unknown, fallback: VideoSaveBitDepth = 8): VideoSaveBitDepth {
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (n === 10) return 10
  if (n === 8) return 8
  return fallback
}

export function normalizeVideoCrf(raw: unknown, fallback = DEFAULT_VIDEO_CRF): number {
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(VIDEO_CRF_MAX, Math.max(VIDEO_CRF_MIN, Math.round(n)))
}

export interface ExtraLoraEntry {
  id: string
  path: string
  strength: number
  /** When false, LoRA is kept in the list but not applied. */
  enabled: boolean
}

/** Generation params common to both panels (aligned with Wan22 Loop Basic settings). */
export interface VideoGenerateParams {
  negative: string
  steps: number
  refinerStep: number
  cfg: number
  cfgHigh: number
  seed: number
  /** How many videos to generate per Generate click (1 = single). */
  batchCount: number
  /** Cached pixels from last resolve (display / fallback). */
  width: number
  height: number
  /** DaSiWa-style preset, e.g. 540p / 720p. */
  resolutionPreset: string
  /** When true, aspect comes from start image (workflow default). */
  scaleFromImage: boolean
  /** Used when scaleFromImage is false. */
  aspectPreset: string
  seconds: number
  fps: number
  shift: number
  sampler: string
  scheduler: string
  loraHighPath: string
  loraLowPath: string
  /** @deprecated Prefer loraHighStrength / loraLowStrength. Kept for migration. */
  loraStrength?: number
  loraHighStrength: number
  loraLowStrength: number
  /** Speed / Lightning LoRA (lightx2v) — legacy master; prefer loraHighEnabled / loraLowEnabled. */
  useLightningLora: boolean
  /** Per-side Speed LoRA enable (path kept when off). */
  loraHighEnabled: boolean
  loraLowEnabled: boolean
  /** Extra LoRAs on high-noise UNET chain (Wan22 LoRA folder). */
  extraLorasHigh: ExtraLoraEntry[]
  /** Extra LoRAs on low-noise UNET chain (Wan22 LoRA folder). */
  extraLorasLow: ExtraLoraEntry[]
  selectedImagePath: string
  prompt: string
  /**
   * Latent motion amplify for NINI2VWanMotion* (1.0 = native-like).
   * Higher values restore dynamics lost at high resolution / Lightning.
   */
  motionAmplitude: number
  /** Optional concat-latent temporal noise (0 = off). */
  noiseStrength: number
}

export type I2vGenerateDraft = VideoGenerateParams

export interface Flf2vGenerateDraft extends VideoGenerateParams {
  endImagePath: string
  flfMode: FlfMode
}

/** Same params as FLF2V; end frame is forced to the loop frame at generate time. */
export type LoopGenerateDraft = Flf2vGenerateDraft

/** @deprecated Kept for settings migration from older installs. */
export type LegacyGenerateDraft = VideoGenerateParams &
  SharedComfyDraft & {
    length?: number
  }

export const WAN_DEFAULT_NEGATIVE =
  'censored, mosaic censoring, bar censor, pixelated, glowing, bloom, blurry, out of focus, low detail, bad anatomy, ugly, overexposed, underexposed, distorted face, extra limbs, cartoonish, 3d render artifacts, duplicate people, unnatural lighting, bad composition, missing shadows, low resolution, poorly textured, glitch, noise, grain, static, motionless, still frame, stylized, artwork, painting, illustration, many people in background, three legs, walking backward, unnatural skin tone, discolored eyelid, red eyelids, closed eyes, poorly drawn hands, extra fingers, fused fingers, poorly drawn face, deformed, disfigured, malformed limbs, fog, mist, voluminous eyelashes,Photorealistic, Hyperrealistic, 3D render, Real life, Live action, static, talking, speaking,'

export const DEFAULT_SHARED_COMFY: SharedComfyDraft = {
  comfyUiBatPath: '',
  ditModelFolder: '',
  highDitPath: '',
  lowDitPath: '',
  speedLoraFolder: '',
  wan22LoraFolder: '',
  upscaleModelFolder: '',
  frameInterpModelFolder: '',
  vaePath: '',
  clipPath: '',
  outputFolder: '',
  videoFormat: 'auto',
  videoCodec: 'h264',
  videoBitDepth: 8,
  videoCrf: DEFAULT_VIDEO_CRF,
  useSageAttention: true,
  useColorMatch: true
}

export const DEFAULT_UPSCALE_GENERATE_DRAFT: UpscaleGenerateDraft = {
  selectedVideoPath: '',
  upscaleModelPath: '',
  interpolationModelPath: '',
  resolutionPreset: '540p',
  interpolationScale: 1,
  removeLastFrame: false
}

export const DEFAULT_FACE_DETAILER_DRAFT: FaceDetailerDraft = {
  selectedVideoPath: '',
  lowDitPath: '',
  loraLowPath: '',
  loraLowStrength: 0.8,
  loraLowEnabled: true,
  bboxModelName: 'segm/99coins_anime_girl_face_m_seg.pt',
  upscaleModelPath: '',
  bboxThreshold: 0.65,
  cropFactor: 1.1,
  takeCount: 1,
  minFaceWidth: 160,
  feather: 50,
  steps: 5,
  startAtStep: 4,
  endAtStep: 5,
  cfg: 1,
  sampler: 'euler_ancestral',
  scheduler: 'sgm_uniform',
  positive: '4k,',
  negative: WAN_DEFAULT_NEGATIVE,
  seed: -1,
  shift: 8
}

export const DEFAULT_VIDEO_PARAMS: VideoGenerateParams = {
  negative: WAN_DEFAULT_NEGATIVE,
  steps: 8,
  refinerStep: 3,
  cfg: 1,
  cfgHigh: 5,
  seed: -1,
  batchCount: 1,
  width: 544,
  height: 960,
  resolutionPreset: '540p',
  scaleFromImage: true,
  aspectPreset: '9:16 - Social',
  seconds: 5,
  fps: 16,
  shift: 8,
  sampler: 'euler',
  scheduler: 'simple',
  loraHighPath: '',
  loraLowPath: '',
  loraHighStrength: 0.8,
  loraLowStrength: 0.8,
  useLightningLora: true,
  loraHighEnabled: true,
  loraLowEnabled: true,
  extraLorasHigh: [],
  extraLorasLow: [],
  selectedImagePath: '',
  prompt: '',
  motionAmplitude: 1.15,
  noiseStrength: 0
}

export const DEFAULT_I2V_GENERATE_DRAFT: I2vGenerateDraft = {
  ...DEFAULT_VIDEO_PARAMS
}

export const DEFAULT_FLF2V_GENERATE_DRAFT: Flf2vGenerateDraft = {
  ...DEFAULT_VIDEO_PARAMS,
  endImagePath: '',
  flfMode: 'flf2v'
}

export const DEFAULT_LOOP_GENERATE_DRAFT: LoopGenerateDraft = {
  ...DEFAULT_VIDEO_PARAMS,
  endImagePath: '',
  flfMode: 'flf2v'
}

/** Frame count: round(seconds * fps) + 1 */
export function framesFromSeconds(seconds: number, fps: number): number {
  const s = Math.max(0.1, seconds)
  const f = Math.max(1, fps)
  return Math.round(s * f) + 1
}

function num(v: unknown, fallback: number, min?: number, max?: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return fallback
  let out = n
  if (min != null) out = Math.max(min, out)
  if (max != null) out = Math.min(max, out)
  return out
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

function newExtraLoraId(): string {
  return `lora-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

export function createExtraLoraEntry(partial?: Partial<ExtraLoraEntry>): ExtraLoraEntry {
  return {
    id: partial?.id || newExtraLoraId(),
    path: partial?.path ?? '',
    strength: partial?.strength ?? 1,
    enabled: partial?.enabled ?? true
  }
}

export function normalizeExtraLoras(raw: unknown): ExtraLoraEntry[] {
  if (!Array.isArray(raw)) return []
  const out: ExtraLoraEntry[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const path = str(o.path)
    const strength = num(o.strength, 1, 0, 2)
    const id = str(o.id) || newExtraLoraId()
    const enabled = typeof o.enabled === 'boolean' ? o.enabled : true
    out.push({ id, path, strength, enabled })
  }
  return out
}

function cloneExtraLorasWithNewIds(entries: ExtraLoraEntry[]): ExtraLoraEntry[] {
  return entries.map((e) => ({ ...e, id: newExtraLoraId() }))
}

function normalizeVideoParams(
  raw: unknown,
  defaults: VideoGenerateParams = DEFAULT_VIDEO_PARAMS
): VideoGenerateParams {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const useLightning = Boolean(r.useLightningLora ?? defaults.useLightningLora)
  const loraHighEnabled =
    typeof r.loraHighEnabled === 'boolean' ? r.loraHighEnabled : useLightning
  const loraLowEnabled =
    typeof r.loraLowEnabled === 'boolean' ? r.loraLowEnabled : useLightning
  const fps = num(r.fps, defaults.fps, 1, 60)
  // Migrate old `length`-only drafts → approximate seconds
  let resolvedSeconds = num(r.seconds, defaults.seconds, 0.5, 60)
  if (r.seconds == null && typeof r.length === 'number' && Number.isFinite(r.length) && fps > 0) {
    resolvedSeconds = Math.max(0.5, Math.round(((r.length as number) - 1) / fps))
  }
  return {
    negative: str(r.negative, defaults.negative) || defaults.negative,
    steps: num(r.steps, defaults.steps, 1, 100),
    refinerStep: num(r.refinerStep, defaults.refinerStep, 1, 100),
    cfg: num(r.cfg, defaults.cfg, 0, 30),
    cfgHigh: num(r.cfgHigh, defaults.cfgHigh, 0, 30),
    seed: num(r.seed, defaults.seed),
    batchCount: num(r.batchCount, defaults.batchCount, 1, 100),
    width: num(r.width, defaults.width, 16, 4096),
    height: num(r.height, defaults.height, 16, 4096),
    resolutionPreset: str(r.resolutionPreset, defaults.resolutionPreset) || defaults.resolutionPreset,
    scaleFromImage:
      typeof r.scaleFromImage === 'boolean' ? r.scaleFromImage : defaults.scaleFromImage,
    aspectPreset: str(r.aspectPreset, defaults.aspectPreset) || defaults.aspectPreset,
    seconds: resolvedSeconds,
    fps,
    shift: num(r.shift, defaults.shift, 0, 20),
    sampler: str(r.sampler, defaults.sampler) || defaults.sampler,
    scheduler: str(r.scheduler, defaults.scheduler) || defaults.scheduler,
    loraHighPath: str(r.loraHighPath),
    loraLowPath: str(r.loraLowPath),
    loraHighStrength: num(
      r.loraHighStrength,
      num(r.loraStrength, defaults.loraHighStrength, 0, 5),
      0,
      5
    ),
    loraLowStrength: num(
      r.loraLowStrength,
      num(r.loraStrength, defaults.loraLowStrength, 0, 5),
      0,
      5
    ),
    useLightningLora: loraHighEnabled || loraLowEnabled,
    loraHighEnabled,
    loraLowEnabled,
    extraLorasHigh: (() => {
      const hasSplit = Array.isArray(r.extraLorasHigh) || Array.isArray(r.extraLorasLow)
      if (hasSplit) return normalizeExtraLoras(r.extraLorasHigh)
      return normalizeExtraLoras(r.extraLoras)
    })(),
    extraLorasLow: (() => {
      const hasSplit = Array.isArray(r.extraLorasHigh) || Array.isArray(r.extraLorasLow)
      if (hasSplit) return normalizeExtraLoras(r.extraLorasLow)
      return cloneExtraLorasWithNewIds(normalizeExtraLoras(r.extraLoras))
    })(),
    selectedImagePath: str(r.selectedImagePath),
    prompt: str(r.prompt),
    motionAmplitude: num(r.motionAmplitude, defaults.motionAmplitude, 1, 2),
    noiseStrength: num(r.noiseStrength, defaults.noiseStrength, 0, 0.3)
  }
}

export function normalizeSharedComfyDraft(raw: unknown): SharedComfyDraft {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const highDitPath = str(r.highDitPath)
  const lowDitPath = str(r.lowDitPath)
  const ditModelFolder =
    str(r.ditModelFolder) || parentDir(highDitPath) || parentDir(lowDitPath)
  // Legacy installs kept Speed LoRA paths on the same object as Comfy paths.
  const speedLoraFolder =
    str(r.speedLoraFolder) || parentDir(str(r.loraHighPath)) || parentDir(str(r.loraLowPath))
  const formatRaw = str(r.videoFormat, DEFAULT_SHARED_COMFY.videoFormat)
  const codecRaw = str(r.videoCodec, DEFAULT_SHARED_COMFY.videoCodec)
  return {
    comfyUiBatPath: str(r.comfyUiBatPath),
    ditModelFolder,
    highDitPath,
    lowDitPath,
    speedLoraFolder,
    wan22LoraFolder: str(r.wan22LoraFolder),
    upscaleModelFolder:
      str(r.upscaleModelFolder) || parentDir(str(r.upscaleModelPath)),
    frameInterpModelFolder:
      str(r.frameInterpModelFolder) || parentDir(str(r.interpolationModelPath)),
    vaePath: str(r.vaePath),
    clipPath: str(r.clipPath),
    outputFolder: str(r.outputFolder),
    videoFormat: isVideoSaveFormat(formatRaw) ? formatRaw : DEFAULT_SHARED_COMFY.videoFormat,
    videoCodec: isVideoSaveCodec(codecRaw) ? codecRaw : DEFAULT_SHARED_COMFY.videoCodec,
    videoBitDepth: normalizeVideoBitDepth(r.videoBitDepth, DEFAULT_SHARED_COMFY.videoBitDepth),
    videoCrf: normalizeVideoCrf(r.videoCrf, DEFAULT_SHARED_COMFY.videoCrf),
    useSageAttention:
      typeof r.useSageAttention === 'boolean'
        ? r.useSageAttention
        : DEFAULT_SHARED_COMFY.useSageAttention,
    useColorMatch:
      typeof r.useColorMatch === 'boolean'
        ? r.useColorMatch
        : DEFAULT_SHARED_COMFY.useColorMatch
  }
}

export function normalizeUpscaleGenerateDraft(raw: unknown): UpscaleGenerateDraft {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const presetRaw = str(r.resolutionPreset)
  const resolutionPreset = isResolutionPreset(presetRaw)
    ? presetRaw
    : DEFAULT_UPSCALE_GENERATE_DRAFT.resolutionPreset || DEFAULT_RESOLUTION_PRESET
  return {
    selectedVideoPath: str(r.selectedVideoPath),
    upscaleModelPath: str(r.upscaleModelPath),
    interpolationModelPath: str(r.interpolationModelPath),
    resolutionPreset,
    interpolationScale: num(
      r.interpolationScale,
      DEFAULT_UPSCALE_GENERATE_DRAFT.interpolationScale,
      1,
      16
    ),
    removeLastFrame:
      typeof r.removeLastFrame === 'boolean'
        ? r.removeLastFrame
        : DEFAULT_UPSCALE_GENERATE_DRAFT.removeLastFrame
  }
}

export function normalizeFaceDetailerDraft(raw: unknown): FaceDetailerDraft {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const d = DEFAULT_FACE_DETAILER_DRAFT
  const seedRaw = typeof r.seed === 'number' ? r.seed : Number(r.seed)
  const seed = Number.isFinite(seedRaw) ? Math.floor(seedRaw) : d.seed
  const steps = Math.max(1, Math.round(num(r.steps, d.steps, 1, 50)))
  const startAtStep = Math.max(
    0,
    Math.min(steps - 1, Math.round(num(r.startAtStep, d.startAtStep, 0, 100)))
  )
  return {
    selectedVideoPath: str(r.selectedVideoPath),
    lowDitPath: str(r.lowDitPath),
    loraLowPath: str(r.loraLowPath),
    loraLowStrength: num(r.loraLowStrength, d.loraLowStrength, 0, 5),
    loraLowEnabled:
      typeof r.loraLowEnabled === 'boolean' ? r.loraLowEnabled : d.loraLowEnabled,
    bboxModelName: str(r.bboxModelName) || d.bboxModelName,
    upscaleModelPath: str(r.upscaleModelPath),
    bboxThreshold: num(r.bboxThreshold, d.bboxThreshold, 0.05, 1),
    cropFactor: num(r.cropFactor, d.cropFactor, 1, 3),
    takeCount: Math.max(1, Math.round(num(r.takeCount, d.takeCount, 1, 8))),
    minFaceWidth: Math.max(8, Math.round(num(r.minFaceWidth, d.minFaceWidth, 8, 4096))),
    feather: Math.max(0, Math.round(num(r.feather, d.feather, 0, 255))),
    steps,
    startAtStep,
    endAtStep: steps,
    cfg: num(r.cfg, d.cfg, 0, 30),
    sampler: str(r.sampler) || d.sampler,
    scheduler: str(r.scheduler) || d.scheduler,
    positive: typeof r.positive === 'string' ? r.positive : d.positive,
    negative: typeof r.negative === 'string' ? r.negative : d.negative,
    seed,
    shift: num(r.shift, d.shift, 0, 20)
  }
}

export function normalizeI2vGenerateDraft(raw: unknown): I2vGenerateDraft {
  return normalizeVideoParams(raw, DEFAULT_I2V_GENERATE_DRAFT)
}

export function normalizeFlf2vGenerateDraft(raw: unknown): Flf2vGenerateDraft {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const base = normalizeVideoParams(raw, DEFAULT_FLF2V_GENERATE_DRAFT)
  const flfMode: FlfMode = r.flfMode === 'wanfun_inpaint' ? 'wanfun_inpaint' : 'flf2v'
  return {
    ...base,
    endImagePath: str(r.endImagePath),
    flfMode
  }
}

export function normalizeLoopGenerateDraft(raw: unknown): LoopGenerateDraft {
  return normalizeFlf2vGenerateDraft(raw ?? DEFAULT_LOOP_GENERATE_DRAFT)
}

/**
 * Migrate legacy `generateDraft` (paths + params in one object) into shared + i2v + flf + loop drafts.
 */
export function migrateGenerateSettings(raw: Record<string, unknown>): {
  sharedComfy: SharedComfyDraft
  i2vDraft: I2vGenerateDraft
  flf2vDraft: Flf2vGenerateDraft
  loopDraft: LoopGenerateDraft
  upscaleDraft: UpscaleGenerateDraft
  faceDetailerDraft: FaceDetailerDraft
} {
  const legacy = raw.generateDraft
  const hasNew =
    raw.sharedComfy != null ||
    raw.i2vDraft != null ||
    raw.flf2vDraft != null ||
    raw.loopDraft != null ||
    raw.upscaleDraft != null ||
    raw.faceDetailerDraft != null

  if (hasNew) {
    const sharedFromLegacy =
      legacy && typeof legacy === 'object'
        ? normalizeSharedComfyDraft(legacy)
        : DEFAULT_SHARED_COMFY
    const shared = {
      ...sharedFromLegacy,
      ...normalizeSharedComfyDraft(raw.sharedComfy)
    }
    // Prefer explicit sharedComfy fields when present
    const sc = raw.sharedComfy && typeof raw.sharedComfy === 'object'
      ? (raw.sharedComfy as Record<string, unknown>)
      : null
    if (sc) {
      for (const key of Object.keys(DEFAULT_SHARED_COMFY) as (keyof SharedComfyDraft)[]) {
        const v = sc[key]
        if (typeof v === 'string' && v.length > 0) {
          ;(shared as Record<string, unknown>)[key] = v
        } else if (typeof v === 'number' && Number.isFinite(v)) {
          ;(shared as Record<string, unknown>)[key] = v
        } else if (typeof v === 'boolean') {
          ;(shared as Record<string, unknown>)[key] = v
        }
      }
    }
    const i2vDraft = normalizeI2vGenerateDraft(raw.i2vDraft ?? legacy)
    if (!shared.speedLoraFolder.trim()) {
      shared.speedLoraFolder =
        parentDir(i2vDraft.loraHighPath) || parentDir(i2vDraft.loraLowPath)
    }
    const upscaleDraft = normalizeUpscaleGenerateDraft(raw.upscaleDraft)
    if (!shared.upscaleModelFolder.trim()) {
      shared.upscaleModelFolder = parentDir(upscaleDraft.upscaleModelPath)
    }
    if (!shared.frameInterpModelFolder.trim()) {
      shared.frameInterpModelFolder = parentDir(upscaleDraft.interpolationModelPath)
    }
    const faceDetailerDraft = normalizeFaceDetailerDraft(raw.faceDetailerDraft)
    if (!shared.upscaleModelFolder.trim()) {
      shared.upscaleModelFolder = parentDir(faceDetailerDraft.upscaleModelPath)
    }
    return {
      sharedComfy: shared,
      i2vDraft,
      flf2vDraft: normalizeFlf2vGenerateDraft(raw.flf2vDraft ?? legacy),
      loopDraft: normalizeLoopGenerateDraft(raw.loopDraft ?? raw.flf2vDraft ?? legacy),
      upscaleDraft,
      faceDetailerDraft
    }
  }

  if (legacy && typeof legacy === 'object') {
    return {
      sharedComfy: normalizeSharedComfyDraft(legacy),
      i2vDraft: normalizeI2vGenerateDraft(legacy),
      flf2vDraft: normalizeFlf2vGenerateDraft(legacy),
      loopDraft: normalizeLoopGenerateDraft(legacy),
      upscaleDraft: normalizeUpscaleGenerateDraft(raw.upscaleDraft),
      faceDetailerDraft: normalizeFaceDetailerDraft(raw.faceDetailerDraft)
    }
  }

  return {
    sharedComfy: { ...DEFAULT_SHARED_COMFY },
    i2vDraft: { ...DEFAULT_I2V_GENERATE_DRAFT },
    flf2vDraft: { ...DEFAULT_FLF2V_GENERATE_DRAFT },
    loopDraft: { ...DEFAULT_LOOP_GENERATE_DRAFT },
    upscaleDraft: { ...DEFAULT_UPSCALE_GENERATE_DRAFT },
    faceDetailerDraft: { ...DEFAULT_FACE_DETAILER_DRAFT }
  }
}

export function normalizeVideoGenPanel(value: unknown): VideoGenPanel {
  if (value === 'flf2v' || value === 'loop') return value
  return 'i2v'
}

/** Map legacy activeView values (i2v/flf2v/loop/generate) onto videoGen + panel. */
export function normalizeActiveViewAndPanel(value: unknown): {
  activeView: ActiveView
  videoGenPanel: VideoGenPanel | null
} {
  if (value === 'i2v' || value === 'generate') {
    return { activeView: 'videoGen', videoGenPanel: 'i2v' }
  }
  if (value === 'flf2v') return { activeView: 'videoGen', videoGenPanel: 'flf2v' }
  if (value === 'loop') return { activeView: 'videoGen', videoGenPanel: 'loop' }
  if (value === 'videoGen') return { activeView: 'videoGen', videoGenPanel: null }
  if (value === 'upscale') return { activeView: 'upscale', videoGenPanel: null }
  if (value === 'faceDetailer') return { activeView: 'faceDetailer', videoGenPanel: null }
  return { activeView: 'prompt', videoGenPanel: null }
}

export function normalizeActiveView(value: unknown): ActiveView {
  return normalizeActiveViewAndPanel(value).activeView
}

export function pythonInstallPathFromDownloadFolder(
  downloadFolder: string
): string | undefined {
  const trimmed = downloadFolder.trim()
  return trimmed ? join(trimmed, 'python') : undefined
}

export function parentDir(filePath: string): string {
  const norm = filePath.replace(/\\/g, '/')
  const i = norm.lastIndexOf('/')
  return i >= 0 ? filePath.slice(0, i) : ''
}

export function basenamePath(filePath: string): string {
  const norm = filePath.replace(/\\/g, '/')
  const i = norm.lastIndexOf('/')
  return i >= 0 ? filePath.slice(i + 1) : filePath
}
