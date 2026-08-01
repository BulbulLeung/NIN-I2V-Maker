import { join } from '../utils/pathJoin'

export type ActiveView = 'prompt' | 'i2v' | 'flf2v' | 'loop'
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
  vaePath: string
  clipPath: string
  outputFolder: string
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
  /** Speed / Lightning LoRA (lightx2v). */
  useLightningLora: boolean
  /** Extra LoRAs on high-noise UNET chain (Wan22 LoRA folder). */
  extraLorasHigh: ExtraLoraEntry[]
  /** Extra LoRAs on low-noise UNET chain (Wan22 LoRA folder). */
  extraLorasLow: ExtraLoraEntry[]
  selectedImagePath: string
  prompt: string
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
  '色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走'

export const DEFAULT_SHARED_COMFY: SharedComfyDraft = {
  comfyUiBatPath: '',
  ditModelFolder: '',
  highDitPath: '',
  lowDitPath: '',
  speedLoraFolder: '',
  wan22LoraFolder: '',
  vaePath: '',
  clipPath: '',
  outputFolder: ''
}

export const DEFAULT_VIDEO_PARAMS: VideoGenerateParams = {
  negative: WAN_DEFAULT_NEGATIVE,
  steps: 8,
  refinerStep: 3,
  cfg: 1,
  cfgHigh: 5,
  seed: -1,
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
  extraLorasHigh: [],
  extraLorasLow: [],
  selectedImagePath: '',
  prompt: ''
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

/** Frame count from workflow: (round((seconds * fps) / 8) * 8) + 1 */
export function framesFromSeconds(seconds: number, fps: number): number {
  const s = Math.max(0.1, seconds)
  const f = Math.max(1, fps)
  return Math.round((s * f) / 8) * 8 + 1
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
      num(r.loraStrength, defaults.loraHighStrength, 0, 2),
      0,
      2
    ),
    loraLowStrength: num(
      r.loraLowStrength,
      num(r.loraStrength, defaults.loraLowStrength, 0, 2),
      0,
      2
    ),
    useLightningLora: useLightning,
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
    prompt: str(r.prompt)
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
  return {
    comfyUiBatPath: str(r.comfyUiBatPath),
    ditModelFolder,
    highDitPath,
    lowDitPath,
    speedLoraFolder,
    wan22LoraFolder: str(r.wan22LoraFolder),
    vaePath: str(r.vaePath),
    clipPath: str(r.clipPath),
    outputFolder: str(r.outputFolder)
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
} {
  const legacy = raw.generateDraft
  const hasNew =
    raw.sharedComfy != null ||
    raw.i2vDraft != null ||
    raw.flf2vDraft != null ||
    raw.loopDraft != null

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
        if (typeof sc[key] === 'string' && (sc[key] as string).length > 0) {
          shared[key] = sc[key] as string
        }
      }
    }
    const i2vDraft = normalizeI2vGenerateDraft(raw.i2vDraft ?? legacy)
    if (!shared.speedLoraFolder.trim()) {
      shared.speedLoraFolder =
        parentDir(i2vDraft.loraHighPath) || parentDir(i2vDraft.loraLowPath)
    }
    return {
      sharedComfy: shared,
      i2vDraft,
      flf2vDraft: normalizeFlf2vGenerateDraft(raw.flf2vDraft ?? legacy),
      loopDraft: normalizeLoopGenerateDraft(raw.loopDraft ?? raw.flf2vDraft ?? legacy)
    }
  }

  if (legacy && typeof legacy === 'object') {
    return {
      sharedComfy: normalizeSharedComfyDraft(legacy),
      i2vDraft: normalizeI2vGenerateDraft(legacy),
      flf2vDraft: normalizeFlf2vGenerateDraft(legacy),
      loopDraft: normalizeLoopGenerateDraft(legacy)
    }
  }

  return {
    sharedComfy: { ...DEFAULT_SHARED_COMFY },
    i2vDraft: { ...DEFAULT_I2V_GENERATE_DRAFT },
    flf2vDraft: { ...DEFAULT_FLF2V_GENERATE_DRAFT },
    loopDraft: { ...DEFAULT_LOOP_GENERATE_DRAFT }
  }
}

export function normalizeActiveView(value: unknown): ActiveView {
  if (value === 'i2v' || value === 'generate') return 'i2v'
  if (value === 'flf2v') return 'flf2v'
  if (value === 'loop') return 'loop'
  return 'prompt'
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
