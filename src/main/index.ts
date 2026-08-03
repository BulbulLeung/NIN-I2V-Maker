import { app, BrowserWindow, dialog, ipcMain, protocol, screen, Menu, shell } from 'electron'
import { join, dirname, basename, extname, resolve as resolvePath, isAbsolute } from 'path'
import { readFileSync, writeFileSync, existsSync, rmSync, copyFileSync } from 'fs'
import { readFile, writeFile, readdir, access, constants, mkdir, stat, copyFile } from 'fs/promises'
import { execFile } from 'child_process'
import { promisify } from 'util'
import {
  cancelComfyInstall,
  comfyStatus,
  connectComfyProgressWs,
  disconnectComfyProgressWs,
  getComfyOutputDir,
  installComfyUi,
  isComfyServerOnline,
  probeComfyBat,
  resolveComfyImagePath,
  setComfyLogListener,
  startComfyUi,
  stopComfyUi
} from './comfyUiEnv'
import {
  cancelPythonInstall,
  installPythonEnv,
  probePython,
  pythonInstallRunning
} from './pythonEnv'
import {
  cancelModelDownload,
  downloadModelPack,
  modelDownloadRunning
} from './modelDownloads'
import { getResourceStats, killProcessByPid } from './resourceStats'
import { probeVideoFile, type VideoProbeInfo } from './videoProbe'
import { readImagePositivePrompt } from './imagePromptMeta'

const execFileAsync = promisify(execFile)

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif'])
const MODEL_EXTS = new Set(['.safetensors', '.ckpt', '.pt', '.pth'])
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov'])

const WAN_DEFAULT_NEGATIVE =
  'vivid colors, overexposed, static, blurry details, subtitles, stylized, artwork, painting, still image, overall grayish, worst quality, low quality, JPEG compression artifacts, ugly, incomplete, extra fingers, poorly drawn hands, poorly drawn face, deformed, disfigured, deformed limbs, fused fingers, still frame, cluttered background, three legs, crowded background, walking backwards'

// Avoid Chromium HTTP disk-cache corruption when loading many local-file:// thumbnails.
app.commandLine.appendSwitch('disable-http-cache')
app.commandLine.appendSwitch('disk-cache-size', '0')
// Chromium logs ERROR:ffmpeg_common "Unsupported pixel format: -1" for valid yuv420p
// HTML5 video (harmless; playback still works). Raise min log level to hide that spam.
app.commandLine.appendSwitch('log-level', '3')
try {
  const cacheDir = join(app.getPath('userData'), 'Cache')
  if (existsSync(cacheDir)) {
    rmSync(cacheDir, { recursive: true, force: true })
  }
} catch {
  /* best-effort */
}

try {
  app.setName('Pictoer')
} catch {
  /* ignore */
}

type TranslationProvider = 'lmstudio' | 'ollama'
type UiGpuMode = 'auto' | 'software' | 'onboard'
type ActiveView = 'prompt' | 'videoGen' | 'upscale'
type VideoGenPanel = 'i2v' | 'flf2v' | 'loop'
type FlfMode = 'flf2v' | 'wanfun_inpaint'

interface PromptPreset {
  id: string
  name: string
  prompt: string
}

interface SharedComfyDraft {
  comfyUiBatPath: string
  ditModelFolder: string
  highDitPath: string
  lowDitPath: string
  speedLoraFolder: string
  wan22LoraFolder: string
  upscaleModelFolder: string
  frameInterpModelFolder: string
  vaePath: string
  clipPath: string
  outputFolder: string
  videoFormat: string
  videoCodec: string
  videoBitDepth: number
  videoCrf: number
  useSageAttention: boolean
  useColorMatch: boolean
}

interface ExtraLoraEntry {
  id: string
  path: string
  strength: number
  enabled: boolean
}

interface VideoGenerateParams {
  negative: string
  steps: number
  refinerStep: number
  cfg: number
  cfgHigh: number
  seed: number
  batchCount: number
  width: number
  height: number
  resolutionPreset: string
  scaleFromImage: boolean
  aspectPreset: string
  seconds: number
  fps: number
  shift: number
  sampler: string
  scheduler: string
  loraHighPath: string
  loraLowPath: string
  loraHighStrength: number
  loraLowStrength: number
  useLightningLora: boolean
  loraHighEnabled: boolean
  loraLowEnabled: boolean
  extraLorasHigh: ExtraLoraEntry[]
  extraLorasLow: ExtraLoraEntry[]
  selectedImagePath: string
  prompt: string
}

type I2vGenerateDraft = VideoGenerateParams

interface Flf2vGenerateDraft extends VideoGenerateParams {
  endImagePath: string
  flfMode: FlfMode
}

type LoopGenerateDraft = Flf2vGenerateDraft

interface UpscaleGenerateDraft {
  selectedVideoPath: string
  upscaleModelPath: string
  interpolationModelPath: string
  resolutionPreset: string
  interpolationScale: number
}

interface AppSettings {
  provider: TranslationProvider
  lmStudioBaseUrl: string
  ollamaBaseUrl: string
  model: string
  targetLanguage: string
  lastFolder: string | null
  imageFolders: string[]
  promptPresets: PromptPreset[]
  activePromptPresetId: string
  sidebarWidth: number
  rightPaneWidth: number
  listViewMode: 'list' | 'thumbs'
  thumbnailWidth: number
  activeView: ActiveView
  videoGenPanel: VideoGenPanel
  uiGpuMode: UiGpuMode
  disableUiGpu: boolean
  pythonPath: string
  downloadFolder: string
  promptImagePath: string
  promptText: string
  useImagePrompt: boolean
  sharedComfy: SharedComfyDraft
  i2vDraft: I2vGenerateDraft
  flf2vDraft: Flf2vGenerateDraft
  loopDraft: LoopGenerateDraft
  upscaleDraft: UpscaleGenerateDraft
  windowWidth: number
  windowHeight: number
  windowX: number | null
  windowY: number | null
  windowMaximized: boolean
}

interface WindowState {
  width: number
  height: number
  x: number | null
  y: number | null
  isMaximized: boolean
}

interface GpuDevice {
  id: string
  label: string
}

const FALLBACK_GPU: GpuDevice[] = [{ id: 'cuda:0', label: 'cuda:0 (not detected)' }]

const DEFAULT_WINDOW: WindowState = {
  width: 1280,
  height: 840,
  x: null,
  y: null,
  isMaximized: false
}

const DEFAULT_SHARED_COMFY: SharedComfyDraft = {
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
  videoCrf: 23,
  useSageAttention: true,
  useColorMatch: true
}

const DEFAULT_VIDEO_PARAMS: VideoGenerateParams = {
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
  prompt: ''
}

const DEFAULT_I2V_DRAFT: I2vGenerateDraft = { ...DEFAULT_VIDEO_PARAMS }

const DEFAULT_FLF2V_DRAFT: Flf2vGenerateDraft = {
  ...DEFAULT_VIDEO_PARAMS,
  endImagePath: '',
  flfMode: 'flf2v'
}

const DEFAULT_LOOP_DRAFT: LoopGenerateDraft = {
  ...DEFAULT_VIDEO_PARAMS,
  endImagePath: '',
  flfMode: 'flf2v'
}

const DEFAULT_UPSCALE_DRAFT: UpscaleGenerateDraft = {
  selectedVideoPath: '',
  upscaleModelPath: '',
  interpolationModelPath: '',
  resolutionPreset: '540p',
  interpolationScale: 1
}

const DEFAULT_SETTINGS: AppSettings = {
  provider: 'lmstudio',
  lmStudioBaseUrl: 'http://localhost:1234/v1',
  ollamaBaseUrl: 'http://localhost:11434',
  model: '',
  targetLanguage: 'zh-TW',
  lastFolder: null,
  imageFolders: [],
  promptPresets: [],
  activePromptPresetId: '',
  sidebarWidth: 260,
  rightPaneWidth: 380,
  listViewMode: 'list',
  thumbnailWidth: 120,
  activeView: 'prompt',
  videoGenPanel: 'i2v',
  uiGpuMode: 'auto',
  disableUiGpu: false,
  pythonPath: '',
  downloadFolder: '',
  promptImagePath: '',
  promptText: '',
  useImagePrompt: false,
  sharedComfy: { ...DEFAULT_SHARED_COMFY },
  i2vDraft: { ...DEFAULT_I2V_DRAFT },
  flf2vDraft: { ...DEFAULT_FLF2V_DRAFT },
  loopDraft: { ...DEFAULT_LOOP_DRAFT },
  upscaleDraft: { ...DEFAULT_UPSCALE_DRAFT },
  windowWidth: DEFAULT_WINDOW.width,
  windowHeight: DEFAULT_WINDOW.height,
  windowX: null,
  windowY: null,
  windowMaximized: false
}

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

function normalizeUiGpuMode(raw: Record<string, unknown> | null | undefined): UiGpuMode {
  const mode = raw?.uiGpuMode
  if (mode === 'auto' || mode === 'onboard' || mode === 'software') return mode
  if (raw?.disableUiGpu === true) return 'software'
  return 'auto'
}

function normalizeVideoGenPanel(raw: unknown): VideoGenPanel {
  if (raw === 'flf2v' || raw === 'loop') return raw
  return 'i2v'
}

function normalizeActiveViewAndPanel(raw: unknown): {
  activeView: ActiveView
  videoGenPanel: VideoGenPanel | null
} {
  if (raw === 'i2v' || raw === 'generate') {
    return { activeView: 'videoGen', videoGenPanel: 'i2v' }
  }
  if (raw === 'flf2v') return { activeView: 'videoGen', videoGenPanel: 'flf2v' }
  if (raw === 'loop') return { activeView: 'videoGen', videoGenPanel: 'loop' }
  if (raw === 'videoGen') return { activeView: 'videoGen', videoGenPanel: null }
  if (raw === 'upscale') return { activeView: 'upscale', videoGenPanel: null }
  return { activeView: 'prompt', videoGenPanel: null }
}

function normalizeListViewMode(raw: unknown): 'list' | 'thumbs' {
  return raw === 'thumbs' ? 'thumbs' : 'list'
}

function numField(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : fallback
}

function strField(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

function parentDirOf(filePath: string): string {
  const raw = (filePath || '').trim()
  if (!raw) return ''
  const idx = Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\'))
  if (idx <= 0) return ''
  return raw.slice(0, idx)
}

function newExtraLoraId(): string {
  return `lora-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

function normalizeExtraLoras(raw: unknown): ExtraLoraEntry[] {
  if (!Array.isArray(raw)) return []
  const out: ExtraLoraEntry[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const path = strField(o.path)
    const strengthRaw = numField(o.strength, 1)
    const strength = Math.min(2, Math.max(0, strengthRaw))
    const id = strField(o.id) || newExtraLoraId()
    const enabled = typeof o.enabled === 'boolean' ? o.enabled : true
    out.push({ id, path, strength, enabled })
  }
  return out
}

function normalizeSharedComfy(raw: unknown): SharedComfyDraft {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const highDitPath = strField(o.highDitPath)
  const lowDitPath = strField(o.lowDitPath)
  const ditModelFolder =
    strField(o.ditModelFolder) || parentDirOf(highDitPath) || parentDirOf(lowDitPath)
  const speedLoraFolder =
    strField(o.speedLoraFolder) ||
    parentDirOf(strField(o.loraHighPath)) ||
    parentDirOf(strField(o.loraLowPath))
  const format = strField(o.videoFormat, DEFAULT_SHARED_COMFY.videoFormat)
  const codec = strField(o.videoCodec, DEFAULT_SHARED_COMFY.videoCodec)
  const bitDepth = numField(o.videoBitDepth, DEFAULT_SHARED_COMFY.videoBitDepth)
  const crf = numField(o.videoCrf, DEFAULT_SHARED_COMFY.videoCrf)
  return {
    comfyUiBatPath: strField(o.comfyUiBatPath),
    ditModelFolder,
    highDitPath,
    lowDitPath,
    speedLoraFolder,
    wan22LoraFolder: strField(o.wan22LoraFolder),
    upscaleModelFolder:
      strField(o.upscaleModelFolder) || parentDirOf(strField(o.upscaleModelPath)),
    frameInterpModelFolder:
      strField(o.frameInterpModelFolder) || parentDirOf(strField(o.interpolationModelPath)),
    vaePath: strField(o.vaePath),
    clipPath: strField(o.clipPath),
    outputFolder: strField(o.outputFolder),
    videoFormat: ['auto', 'mp4', 'webm', 'mkv'].includes(format) ? format : 'auto',
    videoCodec: ['auto', 'h264', 'h265', 'av1', 'vp9', 'prores'].includes(codec)
      ? codec
      : 'h264',
    videoBitDepth: bitDepth === 10 ? 10 : 8,
    videoCrf: Math.min(51, Math.max(0, Math.round(crf))),
    useSageAttention:
      typeof o.useSageAttention === 'boolean'
        ? o.useSageAttention
        : DEFAULT_SHARED_COMFY.useSageAttention,
    useColorMatch:
      typeof o.useColorMatch === 'boolean'
        ? o.useColorMatch
        : DEFAULT_SHARED_COMFY.useColorMatch
  }
}

function normalizeVideoParams(raw: unknown, defaults: VideoGenerateParams): VideoGenerateParams {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const fps = numField(o.fps, defaults.fps)
  let seconds = numField(o.seconds, defaults.seconds)
  if (o.seconds == null && typeof o.length === 'number' && Number.isFinite(o.length) && fps > 0) {
    seconds = Math.max(0.5, Math.round((o.length - 1) / fps))
  }
  return {
    negative: strField(o.negative, defaults.negative) || defaults.negative,
    steps: numField(o.steps, defaults.steps),
    refinerStep: numField(o.refinerStep, defaults.refinerStep),
    cfg: numField(o.cfg, defaults.cfg),
    cfgHigh: numField(o.cfgHigh, defaults.cfgHigh),
    seed: numField(o.seed, defaults.seed),
    batchCount: Math.min(100, Math.max(1, Math.round(numField(o.batchCount, defaults.batchCount)))),
    width: numField(o.width, defaults.width),
    height: numField(o.height, defaults.height),
    resolutionPreset:
      typeof o.resolutionPreset === 'string' && o.resolutionPreset.trim()
        ? o.resolutionPreset
        : defaults.resolutionPreset,
    scaleFromImage:
      typeof o.scaleFromImage === 'boolean' ? o.scaleFromImage : defaults.scaleFromImage,
    aspectPreset:
      typeof o.aspectPreset === 'string' && o.aspectPreset.trim()
        ? o.aspectPreset
        : defaults.aspectPreset,
    seconds,
    fps,
    shift: numField(o.shift, defaults.shift),
    sampler: strField(o.sampler, defaults.sampler) || defaults.sampler,
    scheduler: strField(o.scheduler, defaults.scheduler) || defaults.scheduler,
    loraHighPath: strField(o.loraHighPath),
    loraLowPath: strField(o.loraLowPath),
    loraHighStrength: numField(
      o.loraHighStrength,
      numField(o.loraStrength, defaults.loraHighStrength)
    ),
    loraLowStrength: numField(
      o.loraLowStrength,
      numField(o.loraStrength, defaults.loraLowStrength)
    ),
    loraHighEnabled:
      typeof o.loraHighEnabled === 'boolean'
        ? o.loraHighEnabled
        : Boolean(o.useLightningLora ?? defaults.useLightningLora),
    loraLowEnabled:
      typeof o.loraLowEnabled === 'boolean'
        ? o.loraLowEnabled
        : Boolean(o.useLightningLora ?? defaults.useLightningLora),
    useLightningLora: (() => {
      const high =
        typeof o.loraHighEnabled === 'boolean'
          ? o.loraHighEnabled
          : Boolean(o.useLightningLora ?? defaults.useLightningLora)
      const low =
        typeof o.loraLowEnabled === 'boolean'
          ? o.loraLowEnabled
          : Boolean(o.useLightningLora ?? defaults.useLightningLora)
      return high || low
    })(),
    extraLorasHigh: (() => {
      const hasSplit = Array.isArray(o.extraLorasHigh) || Array.isArray(o.extraLorasLow)
      if (hasSplit) return normalizeExtraLoras(o.extraLorasHigh)
      return normalizeExtraLoras(o.extraLoras)
    })(),
    extraLorasLow: (() => {
      const hasSplit = Array.isArray(o.extraLorasHigh) || Array.isArray(o.extraLorasLow)
      if (hasSplit) return normalizeExtraLoras(o.extraLorasLow)
      return normalizeExtraLoras(o.extraLoras).map((e) => ({
        ...e,
        id: newExtraLoraId()
      }))
    })(),
    selectedImagePath: strField(o.selectedImagePath),
    prompt: strField(o.prompt)
  }
}

function normalizeI2vDraft(raw: unknown): I2vGenerateDraft {
  return normalizeVideoParams(raw, DEFAULT_I2V_DRAFT)
}

function normalizeFlf2vDraft(raw: unknown): Flf2vGenerateDraft {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    ...normalizeVideoParams(raw, DEFAULT_FLF2V_DRAFT),
    endImagePath: strField(o.endImagePath),
    flfMode: o.flfMode === 'wanfun_inpaint' ? 'wanfun_inpaint' : 'flf2v'
  }
}

function normalizeLoopDraft(raw: unknown): LoopGenerateDraft {
  return normalizeFlf2vDraft(raw ?? DEFAULT_LOOP_DRAFT)
}

function normalizeUpscaleDraft(raw: unknown): UpscaleGenerateDraft {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const presets = [
    '144p',
    '240p',
    '360p',
    '480p',
    '540p',
    '576p',
    '720p',
    '900p',
    '1080p',
    '1152p',
    '1440p',
    '2160p',
    '2K',
    '4K'
  ]
  const presetRaw = strField(o.resolutionPreset, DEFAULT_UPSCALE_DRAFT.resolutionPreset)
  const resolutionPreset = presets.includes(presetRaw)
    ? presetRaw
    : DEFAULT_UPSCALE_DRAFT.resolutionPreset
  const interpolationScale = Math.min(
    16,
    Math.max(1, Math.round(numField(o.interpolationScale, 1)))
  )
  return {
    selectedVideoPath: strField(o.selectedVideoPath),
    upscaleModelPath: strField(o.upscaleModelPath),
    interpolationModelPath: strField(o.interpolationModelPath),
    resolutionPreset,
    interpolationScale
  }
}

/** Migrate legacy generateDraft into sharedComfy + i2vDraft + flf2vDraft + loopDraft. */
function migrateGenerateSettings(parsed: Record<string, unknown>): {
  sharedComfy: SharedComfyDraft
  i2vDraft: I2vGenerateDraft
  flf2vDraft: Flf2vGenerateDraft
  loopDraft: LoopGenerateDraft
  upscaleDraft: UpscaleGenerateDraft
} {
  const legacy = parsed.generateDraft
  const hasNew =
    parsed.sharedComfy != null ||
    parsed.i2vDraft != null ||
    parsed.flf2vDraft != null ||
    parsed.loopDraft != null ||
    parsed.upscaleDraft != null

  if (hasNew) {
    const fromLegacy =
      legacy && typeof legacy === 'object' ? normalizeSharedComfy(legacy) : { ...DEFAULT_SHARED_COMFY }
    const shared = { ...fromLegacy, ...normalizeSharedComfy(parsed.sharedComfy) }
    const sc =
      parsed.sharedComfy && typeof parsed.sharedComfy === 'object'
        ? (parsed.sharedComfy as Record<string, unknown>)
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
    const i2vDraft = normalizeI2vDraft(parsed.i2vDraft ?? legacy)
    if (!shared.speedLoraFolder.trim()) {
      shared.speedLoraFolder =
        parentDirOf(i2vDraft.loraHighPath) || parentDirOf(i2vDraft.loraLowPath)
    }
    const upscaleDraft = normalizeUpscaleDraft(parsed.upscaleDraft)
    if (!shared.upscaleModelFolder.trim()) {
      shared.upscaleModelFolder = parentDirOf(upscaleDraft.upscaleModelPath)
    }
    if (!shared.frameInterpModelFolder.trim()) {
      shared.frameInterpModelFolder = parentDirOf(upscaleDraft.interpolationModelPath)
    }
    return {
      sharedComfy: shared,
      i2vDraft,
      flf2vDraft: normalizeFlf2vDraft(parsed.flf2vDraft ?? legacy),
      loopDraft: normalizeLoopDraft(parsed.loopDraft ?? parsed.flf2vDraft ?? legacy),
      upscaleDraft
    }
  }

  if (legacy && typeof legacy === 'object') {
    return {
      sharedComfy: normalizeSharedComfy(legacy),
      i2vDraft: normalizeI2vDraft(legacy),
      flf2vDraft: normalizeFlf2vDraft(legacy),
      loopDraft: normalizeLoopDraft(legacy),
      upscaleDraft: normalizeUpscaleDraft(parsed.upscaleDraft)
    }
  }

  return {
    sharedComfy: { ...DEFAULT_SHARED_COMFY },
    i2vDraft: { ...DEFAULT_I2V_DRAFT },
    flf2vDraft: { ...DEFAULT_FLF2V_DRAFT },
    loopDraft: { ...DEFAULT_LOOP_DRAFT },
    upscaleDraft: { ...DEFAULT_UPSCALE_DRAFT }
  }
}

/** Must run before app.whenReady(); Chromium GPU flags cannot change after that. */
function readUiGpuModeSync(): UiGpuMode {
  try {
    const raw = readFileSync(settingsPath(), 'utf-8')
    return normalizeUiGpuMode(JSON.parse(raw) as Record<string, unknown>)
  } catch {
    return 'auto'
  }
}

const earlyUiGpuMode = readUiGpuModeSync()
if (earlyUiGpuMode === 'software') {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-gpu')
} else if (earlyUiGpuMode === 'onboard') {
  app.commandLine.appendSwitch('force_low_power_gpu')
}

async function loadSettings(): Promise<AppSettings> {
  try {
    const raw = await readFile(settingsPath(), 'utf-8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const uiGpuMode = normalizeUiGpuMode(parsed)
    const migrated = migrateGenerateSettings(parsed)
    const viewAndPanel = normalizeActiveViewAndPanel(parsed.activeView)
    return {
      ...DEFAULT_SETTINGS,
      ...(parsed as Partial<AppSettings>),
      imageFolders: Array.isArray(parsed.imageFolders)
        ? (parsed.imageFolders as string[])
        : DEFAULT_SETTINGS.imageFolders,
      promptPresets: Array.isArray(parsed.promptPresets)
        ? (parsed.promptPresets as PromptPreset[])
        : DEFAULT_SETTINGS.promptPresets,
      activePromptPresetId:
        typeof parsed.activePromptPresetId === 'string'
          ? parsed.activePromptPresetId
          : DEFAULT_SETTINGS.activePromptPresetId,
      listViewMode: normalizeListViewMode(parsed.listViewMode),
      thumbnailWidth:
        typeof parsed.thumbnailWidth === 'number' && Number.isFinite(parsed.thumbnailWidth)
          ? parsed.thumbnailWidth
          : DEFAULT_SETTINGS.thumbnailWidth,
      activeView: viewAndPanel.activeView,
      videoGenPanel:
        viewAndPanel.videoGenPanel ?? normalizeVideoGenPanel(parsed.videoGenPanel),
      uiGpuMode,
      disableUiGpu: uiGpuMode === 'software',
      pythonPath: typeof parsed.pythonPath === 'string' ? parsed.pythonPath : '',
      downloadFolder: typeof parsed.downloadFolder === 'string' ? parsed.downloadFolder : '',
      promptImagePath: typeof parsed.promptImagePath === 'string' ? parsed.promptImagePath : '',
      promptText: typeof parsed.promptText === 'string' ? parsed.promptText : '',
      useImagePrompt:
        typeof parsed.useImagePrompt === 'boolean'
          ? parsed.useImagePrompt
          : DEFAULT_SETTINGS.useImagePrompt,
      sharedComfy: migrated.sharedComfy,
      i2vDraft: migrated.i2vDraft,
      flf2vDraft: migrated.flf2vDraft,
      loopDraft: migrated.loopDraft,
      upscaleDraft: migrated.upscaleDraft
    }
  } catch {
    return {
      ...DEFAULT_SETTINGS,
      sharedComfy: { ...DEFAULT_SHARED_COMFY },
      i2vDraft: { ...DEFAULT_I2V_DRAFT },
      flf2vDraft: { ...DEFAULT_FLF2V_DRAFT },
      loopDraft: { ...DEFAULT_LOOP_DRAFT },
      upscaleDraft: { ...DEFAULT_UPSCALE_DRAFT }
    }
  }
}

async function saveSettings(settings: AppSettings): Promise<void> {
  await writeFile(settingsPath(), JSON.stringify(settings, null, 2), 'utf-8')
}

function getWindowState(settings: AppSettings): WindowState {
  return {
    width: settings.windowWidth || DEFAULT_WINDOW.width,
    height: settings.windowHeight || DEFAULT_WINDOW.height,
    x: settings.windowX ?? null,
    y: settings.windowY ?? null,
    isMaximized: Boolean(settings.windowMaximized)
  }
}

function isVisibleOnAnyDisplay(bounds: {
  x: number
  y: number
  width: number
  height: number
}): boolean {
  const displays = screen.getAllDisplays()
  return displays.some((d) => {
    const a = d.workArea
    const overlapX = Math.max(
      0,
      Math.min(bounds.x + bounds.width, a.x + a.width) - Math.max(bounds.x, a.x)
    )
    const overlapY = Math.max(
      0,
      Math.min(bounds.y + bounds.height, a.y + a.height) - Math.max(bounds.y, a.y)
    )
    return overlapX >= 80 && overlapY >= 80
  })
}

async function persistWindowState(win: BrowserWindow): Promise<void> {
  const isMaximized = win.isMaximized()
  const bounds = isMaximized ? win.getNormalBounds() : win.getBounds()
  const current = await loadSettings()
  await saveSettings({
    ...current,
    windowWidth: bounds.width,
    windowHeight: bounds.height,
    windowX: bounds.x,
    windowY: bounds.y,
    windowMaximized: isMaximized
  })
}

function captionPathForImage(imagePath: string): string {
  const dir = dirname(imagePath)
  const stem = basename(imagePath, extname(imagePath))
  return join(dir, `${stem}.txt`)
}

function mimeForExt(ext: string): string {
  switch (ext.toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.png':
      return 'image/png'
    case '.webp':
      return 'image/webp'
    case '.gif':
      return 'image/gif'
    case '.bmp':
      return 'image/bmp'
    case '.mp4':
      return 'video/mp4'
    case '.webm':
      return 'video/webm'
    case '.mov':
      return 'video/quicktime'
    default:
      return 'application/octet-stream'
  }
}

async function listCudaDevices(): Promise<GpuDevice[]> {
  try {
    const { stdout } = await execFileAsync(
      'nvidia-smi',
      ['--query-gpu=index,name', '--format=csv,noheader,nounits'],
      { timeout: 5000, windowsHide: true, encoding: 'utf8' }
    )
    const devices: GpuDevice[] = []
    for (const line of stdout.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const comma = trimmed.indexOf(',')
      if (comma < 0) continue
      const indexStr = trimmed.slice(0, comma).trim()
      const name = trimmed.slice(comma + 1).trim()
      const index = Number(indexStr)
      if (!Number.isInteger(index) || index < 0) continue
      const id = `cuda:${index}`
      devices.push({
        id,
        label: name ? `${id} — ${name}` : id
      })
    }
    return devices.length > 0 ? devices : FALLBACK_GPU
  } catch {
    return FALLBACK_GPU
  }
}

let mainWindow: BrowserWindow | null = null
let saveWindowTimer: ReturnType<typeof setTimeout> | null = null

function scheduleSaveWindowState(win: BrowserWindow): void {
  if (saveWindowTimer) clearTimeout(saveWindowTimer)
  saveWindowTimer = setTimeout(() => {
    saveWindowTimer = null
    void persistWindowState(win)
  }, 400)
}

async function createWindow(): Promise<void> {
  const settings = await loadSettings()
  const saved = getWindowState(settings)

  const options: Electron.BrowserWindowConstructorOptions = {
    width: Math.max(900, saved.width),
    height: Math.max(600, saved.height),
    minWidth: 900,
    minHeight: 600,
    title: `${app.getName()} Ver${app.getVersion()}`,
    show: false,
    autoHideMenuBar: true,
    ...(!app.isPackaged ? { icon: join(__dirname, '../../build/icon.ico') } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  }

  if (
    saved.x !== null &&
    saved.y !== null &&
    isVisibleOnAnyDisplay({
      x: saved.x,
      y: saved.y,
      width: options.width!,
      height: options.height!
    })
  ) {
    options.x = saved.x
    options.y = saved.y
  }

  mainWindow = new BrowserWindow(options)
  mainWindow.setMenuBarVisibility(false)
  Menu.setApplicationMenu(null)
  mainWindow.on('page-title-updated', (event) => {
    event.preventDefault()
  })

  mainWindow.once('ready-to-show', () => {
    if (!mainWindow) return
    if (saved.isMaximized) mainWindow.maximize()
    mainWindow.show()
  })

  mainWindow.on('resize', () => {
    if (mainWindow && !mainWindow.isMinimized()) scheduleSaveWindowState(mainWindow)
  })
  mainWindow.on('move', () => {
    if (mainWindow && !mainWindow.isMinimized()) scheduleSaveWindowState(mainWindow)
  })
  mainWindow.on('maximize', () => {
    if (mainWindow) scheduleSaveWindowState(mainWindow)
  })
  mainWindow.on('unmaximize', () => {
    if (mainWindow) scheduleSaveWindowState(mainWindow)
  })
  mainWindow.on('close', () => {
    if (saveWindowTimer) {
      clearTimeout(saveWindowTimer)
      saveWindowTimer = null
    }
    if (!mainWindow) return
    const win = mainWindow
    const isMaximized = win.isMaximized()
    const bounds = isMaximized ? win.getNormalBounds() : win.getBounds()
    try {
      let current: AppSettings = {
        ...DEFAULT_SETTINGS,
        sharedComfy: { ...DEFAULT_SHARED_COMFY },
        i2vDraft: { ...DEFAULT_I2V_DRAFT },
        flf2vDraft: { ...DEFAULT_FLF2V_DRAFT },
        loopDraft: { ...DEFAULT_LOOP_DRAFT }
      }
      try {
        const parsed = JSON.parse(readFileSync(settingsPath(), 'utf-8')) as Record<string, unknown>
        const migrated = migrateGenerateSettings(parsed)
        current = {
          ...DEFAULT_SETTINGS,
          ...(parsed as Partial<AppSettings>),
          sharedComfy: migrated.sharedComfy,
          i2vDraft: migrated.i2vDraft,
          flf2vDraft: migrated.flf2vDraft,
          loopDraft: migrated.loopDraft
        }
      } catch {
        // use defaults
      }
      writeFileSync(
        settingsPath(),
        JSON.stringify(
          {
            ...current,
            windowWidth: bounds.width,
            windowHeight: bounds.height,
            windowX: bounds.x,
            windowY: bounds.y,
            windowMaximized: isMaximized
          },
          null,
          2
        ),
        'utf-8'
      )
    } catch {
      // Best-effort; resize handlers already debounce-save
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'local-file',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      bypassCSP: true,
      stream: true
    }
  }
])

app.whenReady().then(async () => {
  protocol.handle('local-file', async (request) => {
    const parsed = new URL(request.url)
    let filePath = decodeURIComponent(parsed.pathname)
    if (filePath.startsWith('/')) filePath = filePath.slice(1)
    const rangeHeader = request.headers.get('Range')
    const mime = mimeForExt(extname(filePath))
    try {
      const buf = await readFile(filePath)
      const fileSize = buf.length

      if (rangeHeader) {
        const m = /bytes=(\d*)-(\d*)/.exec(rangeHeader)
        if (m) {
          let start = m[1] !== '' ? Number(m[1]) : 0
          let end = m[2] !== '' ? Number(m[2]) : fileSize - 1
          if (
            Number.isNaN(start) ||
            Number.isNaN(end) ||
            start < 0 ||
            end < start ||
            start >= fileSize
          ) {
            return new Response(null, {
              status: 416,
              headers: {
                'Content-Range': `bytes */${fileSize}`,
                'Accept-Ranges': 'bytes'
              }
            })
          }
          end = Math.min(end, fileSize - 1)
          const chunk = buf.subarray(start, end + 1)
          return new Response(chunk, {
            status: 206,
            headers: {
              'Content-Type': mime,
              'Content-Length': String(chunk.length),
              'Content-Range': `bytes ${start}-${end}/${fileSize}`,
              'Accept-Ranges': 'bytes',
              'Cache-Control': 'no-store'
            }
          })
        }
      }

      return new Response(buf, {
        status: 200,
        headers: {
          'Content-Type': mime,
          'Content-Length': String(fileSize),
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store'
        }
      })
    } catch {
      return new Response('Not Found', { status: 404 })
    }
  })

  ipcMain.handle('dialog:openFolder', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle(
    'dialog:openFile',
    async (
      _event,
      opts?: {
        title?: string
        filters?: { name: string; extensions: string[] }[]
      }
    ) => {
      const result = await dialog.showOpenDialog(mainWindow!, {
        title: opts?.title,
        properties: ['openFile'],
        filters: opts?.filters ?? [{ name: 'All Files', extensions: ['*'] }]
      })
      if (result.canceled || result.filePaths.length === 0) return null
      return result.filePaths[0]
    }
  )

  ipcMain.handle('shell:openPath', async (_event, targetPath: string) => {
    const raw = typeof targetPath === 'string' ? targetPath.trim() : ''
    if (!raw) return { ok: false, error: 'Path is empty' }
    const resolved = isAbsolute(raw) ? raw : resolvePath(raw)
    try {
      await mkdir(resolved, { recursive: true })
    } catch {
      // May already exist as a file, or permissions failed — let openPath report.
    }
    const error = await shell.openPath(resolved)
    if (error) return { ok: false, error }
    return { ok: true, path: resolved }
  })

  ipcMain.handle('shell:showItemInFolder', async (_event, fullPath: string) => {
    const raw = typeof fullPath === 'string' ? fullPath.trim() : ''
    if (!raw) return { ok: false, error: 'Path is empty' }
    shell.showItemInFolder(raw)
    return { ok: true }
  })

  ipcMain.handle('shell:trashItem', async (_event, fullPath: string) => {
    const raw = typeof fullPath === 'string' ? fullPath.trim() : ''
    if (!raw) return { ok: false, error: 'Path is empty' }
    if (!existsSync(raw)) return { ok: false, error: 'File not found' }
    try {
      await shell.trashItem(raw)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('fs:listImages', async (_event, dir: string) => {
    const entries = await readdir(dir, { withFileTypes: true })
    const captionStems = new Set<string>()
    const imageEntries: { name: string; path: string }[] = []

    for (const entry of entries) {
      if (!entry.isFile()) continue
      const ext = extname(entry.name).toLowerCase()
      if (ext === '.txt') {
        captionStems.add(basename(entry.name, extname(entry.name)).toLowerCase())
        continue
      }
      if (!IMAGE_EXTS.has(ext)) continue
      imageEntries.push({ name: entry.name, path: join(dir, entry.name) })
    }

    const images = imageEntries.map(({ name, path: imagePath }) => {
      const stem = basename(name, extname(name)).toLowerCase()
      return { path: imagePath, name, hasCaption: captionStems.has(stem) }
    })

    images.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    return images
  })

  ipcMain.handle('fs:readCaption', async (_event, imagePath: string) => {
    const txtPath = captionPathForImage(imagePath)
    try {
      return await readFile(txtPath, 'utf-8')
    } catch {
      return ''
    }
  })

  ipcMain.handle('fs:writeCaption', async (_event, imagePath: string, text: string) => {
    const txtPath = captionPathForImage(imagePath)
    await writeFile(txtPath, text, 'utf-8')
    return true
  })

  ipcMain.handle('fs:readImageBase64', async (_event, imagePath: string) => {
    const buf = await readFile(imagePath)
    return {
      mimeType: mimeForExt(extname(imagePath)),
      base64: buf.toString('base64')
    }
  })

  ipcMain.handle(
    'fs:readImagePositivePrompt',
    async (
      _event,
      imagePath: string
    ): Promise<{ positive: string | null; source: string | null; error?: string }> => {
      try {
        return await readImagePositivePrompt(imagePath)
      } catch (err) {
        return {
          positive: null,
          source: null,
          error: err instanceof Error ? err.message : String(err)
        }
      }
    }
  )

  ipcMain.handle('fs:pathExists', async (_event, targetPath: string) => {
    const raw = typeof targetPath === 'string' ? targetPath.trim() : ''
    if (!raw) return false
    try {
      await access(raw, constants.F_OK)
      return true
    } catch {
      return false
    }
  })

  ipcMain.handle('fs:listModelFiles', async (_event, folder: string) => {
    const dir = (folder || '').trim()
    if (!dir) return [] as { name: string; path: string }[]
    try {
      await access(dir, constants.R_OK)
    } catch {
      return []
    }
    try {
      const entries = await readdir(dir, { withFileTypes: true })
      const files: { name: string; path: string }[] = []
      for (const ent of entries) {
        if (!ent.isFile()) continue
        const ext = extname(ent.name).toLowerCase()
        if (!MODEL_EXTS.has(ext)) continue
        files.push({ name: ent.name, path: join(dir, ent.name) })
      }
      files.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
      return files
    } catch {
      return []
    }
  })

  ipcMain.handle('settings:get', async () => loadSettings())

  ipcMain.handle('settings:set', async (_event, settings: Partial<AppSettings>) => {
    const current = await loadSettings()
    const merged = { ...current, ...settings }
    const uiGpuMode = normalizeUiGpuMode(merged as unknown as Record<string, unknown>)
    const migrated = migrateGenerateSettings(merged as unknown as Record<string, unknown>)
    const viewAndPanel = normalizeActiveViewAndPanel(merged.activeView)
    await saveSettings({
      ...merged,
      listViewMode: normalizeListViewMode(merged.listViewMode),
      activeView: viewAndPanel.activeView,
      videoGenPanel:
        viewAndPanel.videoGenPanel ?? normalizeVideoGenPanel(merged.videoGenPanel),
      sharedComfy: {
        ...migrated.sharedComfy,
        ...(settings.sharedComfy || {})
      },
      i2vDraft: {
        ...migrated.i2vDraft,
        ...(settings.i2vDraft || {})
      },
      flf2vDraft: {
        ...migrated.flf2vDraft,
        ...(settings.flf2vDraft || {})
      },
      loopDraft: {
        ...migrated.loopDraft,
        ...(settings.loopDraft || {})
      },
      upscaleDraft: {
        ...migrated.upscaleDraft,
        ...(settings.upscaleDraft || {})
      },
      uiGpuMode,
      disableUiGpu: uiGpuMode === 'software',
      // Window geometry is owned by main; never let renderer wipe it
      windowWidth: current.windowWidth,
      windowHeight: current.windowHeight,
      windowX: current.windowX,
      windowY: current.windowY,
      windowMaximized: current.windowMaximized
    })
    return true
  })

  ipcMain.handle('system:getResourceStats', async (_event, deviceId?: string) =>
    getResourceStats(deviceId)
  )

  ipcMain.handle('system:killProcess', async (_event, pid: number) => killProcessByPid(pid))

  ipcMain.handle('gpu:listDevices', async () => listCudaDevices())

  ipcMain.handle('download:defaultFolder', async () => app.getPath('userData'))

  ipcMain.handle('python:probe', async (_event, pythonPath?: string) => probePython(pythonPath))

  ipcMain.handle('python:cancelInstall', async () => cancelPythonInstall())

  ipcMain.handle('python:install', async (_event, opts?: { installPath?: string }) => {
    if (pythonInstallRunning()) {
      return { ok: false, message: 'Python install already running' }
    }
    return installPythonEnv({
      installPath: opts?.installPath,
      onProgress: (p) => {
        mainWindow?.webContents.send('python:installProgress', p)
      }
    })
  })

  ipcMain.handle('comfy:probeBat', async (_event, batPath?: string) =>
    probeComfyBat(batPath || '')
  )

  ipcMain.handle('comfy:cancelInstall', async () => cancelComfyInstall())

  ipcMain.handle(
    'comfy:install',
    async (_event, opts?: { downloadFolder?: string; pythonPath?: string }) => {
      return installComfyUi({
        downloadFolder: opts?.downloadFolder,
        pythonPath: opts?.pythonPath,
        onProgress: (p) => {
          mainWindow?.webContents.send('comfy:installProgress', p)
        }
      })
    }
  )

  ipcMain.handle('models:cancelDownload', async () => cancelModelDownload())

  ipcMain.handle(
    'models:download',
    async (_event, opts: { packId: string; downloadFolder?: string }) => {
      if (modelDownloadRunning()) {
        return { ok: false, message: 'A model download is already running' }
      }
      return downloadModelPack(opts.packId, opts.downloadFolder, (p) => {
        mainWindow?.webContents.send('models:downloadProgress', p)
      })
    }
  )

  ipcMain.handle(
    'comfy:start',
    async (
      _event,
      opts: {
        batPath: string
        pythonPath?: string
        modelsRoot?: string
        loraFolders?: string[]
        ditFolders?: string[]
        vaeFolders?: string[]
        clipFolders?: string[]
        upscaleFolders?: string[]
        frameInterpFolders?: string[]
        useSageAttention?: boolean
      }
    ) => startComfyUi(opts)
  )

  ipcMain.handle('comfy:stop', async () => stopComfyUi())

  setComfyLogListener((payload) => {
    mainWindow?.webContents.send('comfy:log', payload)
  })

  ipcMain.handle('comfy:status', async () => {
    const proc = comfyStatus()
    const online = await isComfyServerOnline()
    return { ...proc, online, outputDir: proc.outputDir || getComfyOutputDir() }
  })

  ipcMain.handle(
    'comfy:httpRequest',
    async (
      _event,
      opts: {
        url: string
        method?: string
        headers?: Record<string, string>
        body?: string
        timeoutMs?: number
      }
    ) => {
      try {
        const method = (opts.method || 'GET').toUpperCase()
        const timeoutMs = opts.timeoutMs ?? 120_000
        const res = await fetch(opts.url, {
          method,
          headers: opts.headers,
          body: method === 'GET' || method === 'HEAD' ? undefined : opts.body,
          signal: AbortSignal.timeout(timeoutMs)
        })
        const text = await res.text()
        return { ok: res.ok, status: res.status, text }
      } catch (err) {
        return {
          ok: false,
          status: 0,
          text: '',
          error: err instanceof Error ? err.message : String(err)
        }
      }
    }
  )

  ipcMain.handle(
    'comfy:progressConnect',
    async (
      event,
      opts: { baseUrl?: string; clientId: string }
    ): Promise<{ ok: boolean; error?: string }> => {
      const clientId = (opts?.clientId || '').trim()
      if (!clientId) return { ok: false, error: 'clientId is required' }
      const sender = event.sender
      return connectComfyProgressWs({
        baseUrl: opts?.baseUrl || 'http://127.0.0.1:8188',
        clientId,
        onEvent: (payload) => {
          if (!sender.isDestroyed()) {
            sender.send('comfy:progress', payload)
          }
        }
      })
    }
  )

  ipcMain.handle('comfy:progressDisconnect', async () => {
    disconnectComfyProgressWs()
    return { ok: true }
  })

  ipcMain.handle(
    'comfy:resolveImagePath',
    async (
      _event,
      img: { filename: string; subfolder?: string; type?: string }
    ): Promise<{ ok: boolean; path?: string; error?: string }> => {
      try {
        const abs = resolveComfyImagePath(img)
        if (!existsSync(abs)) {
          return { ok: false, error: `Image not found: ${abs}` }
        }
        return { ok: true, path: abs }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle('comfy:getOutputDir', async () => ({
    ok: true,
    path: getComfyOutputDir()
  }))

  ipcMain.handle(
    'comfy:uploadImage',
    async (
      _event,
      opts: { imagePath: string; baseUrl?: string }
    ): Promise<{ name: string; subfolder: string; type: string }> => {
      const imagePath = (opts?.imagePath || '').trim()
      if (!imagePath) throw new Error('imagePath is empty')
      if (!existsSync(imagePath)) {
        throw new Error(`Image not found: ${imagePath}`)
      }
      const baseUrl = ((opts?.baseUrl || 'http://127.0.0.1:8188').trim() || 'http://127.0.0.1:8188').replace(
        /\/$/,
        ''
      )
      const buf = await readFile(imagePath)
      const fileName = basename(imagePath)
      const mime = mimeForExt(extname(imagePath))
      const bytes = new Uint8Array(buf)
      const blob = new Blob([bytes], { type: mime })
      const form = new FormData()
      form.append('image', blob, fileName)

      const res = await fetch(`${baseUrl}/upload/image`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(120_000)
      })
      const text = await res.text()
      if (!res.ok) {
        throw new Error(`Upload failed HTTP ${res.status}: ${text.slice(0, 400)}`)
      }
      let parsed: { name?: string; subfolder?: string; type?: string }
      try {
        parsed = JSON.parse(text) as { name?: string; subfolder?: string; type?: string }
      } catch {
        throw new Error(`Invalid upload response: ${text.slice(0, 400)}`)
      }
      return {
        name: parsed.name || fileName,
        subfolder: parsed.subfolder || '',
        type: parsed.type || 'input'
      }
    }
  )

  ipcMain.handle(
    'comfy:uploadVideo',
    async (
      _event,
      opts: { videoPath: string; baseUrl?: string }
    ): Promise<{ name: string; subfolder: string; type: string }> => {
      const videoPath = (opts?.videoPath || '').trim()
      if (!videoPath) throw new Error('videoPath is empty')
      if (!existsSync(videoPath)) {
        throw new Error(`Video not found: ${videoPath}`)
      }
      const baseUrl = ((opts?.baseUrl || 'http://127.0.0.1:8188').trim() || 'http://127.0.0.1:8188').replace(
        /\/$/,
        ''
      )
      const buf = await readFile(videoPath)
      const fileName = basename(videoPath)
      const mime = mimeForExt(extname(videoPath))
      const bytes = new Uint8Array(buf)
      const blob = new Blob([bytes], { type: mime })
      const form = new FormData()
      form.append('image', blob, fileName)

      const res = await fetch(`${baseUrl}/upload/image`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(300_000)
      })
      const text = await res.text()
      if (!res.ok) {
        throw new Error(`Upload failed HTTP ${res.status}: ${text.slice(0, 400)}`)
      }
      let parsed: { name?: string; subfolder?: string; type?: string }
      try {
        parsed = JSON.parse(text) as { name?: string; subfolder?: string; type?: string }
      } catch {
        throw new Error(`Invalid upload response: ${text.slice(0, 400)}`)
      }
      return {
        name: parsed.name || fileName,
        subfolder: parsed.subfolder || '',
        type: parsed.type || 'input'
      }
    }
  )

  ipcMain.handle(
    'gallery:saveVideo',
    async (
      _event,
      opts: {
        sourcePath: string
        outputFolder: string
        fileName?: string
        namePrefix?: string
        seed?: number
      }
    ): Promise<{ ok: boolean; path?: string; dir?: string; error?: string }> => {
      const sourcePath = (opts?.sourcePath || '').trim()
      const outputFolder = (opts?.outputFolder || '').trim()
      if (!sourcePath) return { ok: false, error: 'Source path is empty' }
      if (!outputFolder) return { ok: false, error: 'Output folder is empty' }
      if (!existsSync(sourcePath)) {
        return { ok: false, error: `Source not found: ${sourcePath}` }
      }
      try {
        await mkdir(outputFolder, { recursive: true })
        const ext = extname(sourcePath) || '.mp4'
        const stamp = new Date()
          .toISOString()
          .replace(/[-:]/g, '')
          .replace(/\.\d+Z$/, 'Z')
          .replace('T', '_')
        const seedNum =
          typeof opts?.seed === 'number' && Number.isFinite(opts.seed)
            ? Math.floor(opts.seed)
            : null
        const prefixRaw = (opts?.namePrefix || '').trim()
        const safePrefix = prefixRaw.replace(/[<>:"/\\|?*\x00-\x1f]+/g, '_').replace(/_+/g, '_')
        const seedSuffix =
          seedNum != null ? (safePrefix ? `_${seedNum}` : `_seed${seedNum}`) : ''
        const safeBase =
          (opts?.fileName || '').trim().replace(/[<>:"/\\|?*\x00-\x1f]+/g, '_') ||
          (safePrefix
            ? `${safePrefix}_${stamp}${seedSuffix}`
            : `i2v_${stamp}${seedSuffix}`)
        const baseName = safeBase.toLowerCase().endsWith(ext.toLowerCase())
          ? safeBase
          : `${safeBase}${ext}`
        let dest = join(outputFolder, baseName)
        if (existsSync(dest)) {
          const stem = baseName.slice(0, -ext.length)
          dest = join(outputFolder, `${stem}_${Date.now()}${ext}`)
        }
        try {
          await copyFile(sourcePath, dest)
        } catch {
          copyFileSync(sourcePath, dest)
        }
        return { ok: true, path: dest, dir: outputFolder }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle(
    'gallery:listVideos',
    async (
      _event,
      opts: { outputFolder: string }
    ): Promise<{
      ok: boolean
      error?: string
      videos: { path: string; name: string; mtimeMs: number }[]
    }> => {
      const dir = (opts?.outputFolder || '').trim()
      if (!dir) {
        return { ok: false, error: 'Output folder is empty', videos: [] }
      }
      try {
        await access(dir, constants.R_OK)
      } catch {
        return { ok: true, videos: [] }
      }
      try {
        const entries = await readdir(dir, { withFileTypes: true })
        const videos: { path: string; name: string; mtimeMs: number }[] = []
        for (const ent of entries) {
          if (!ent.isFile()) continue
          const ext = extname(ent.name).toLowerCase()
          if (!VIDEO_EXTS.has(ext)) continue
          const full = join(dir, ent.name)
          let mtimeMs = 0
          try {
            mtimeMs = (await stat(full)).mtimeMs
          } catch {
            mtimeMs = 0
          }
          videos.push({ path: full, name: ent.name, mtimeMs })
        }
        videos.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name))
        return { ok: true, videos }
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          videos: []
        }
      }
    }
  )

  ipcMain.handle(
    'gallery:probeVideo',
    async (
      _event,
      opts: { path: string }
    ): Promise<{ ok: boolean; error?: string; info?: VideoProbeInfo }> => {
      const filePath = (opts?.path || '').trim()
      if (!filePath) {
        return { ok: false, error: 'Video path is empty' }
      }
      try {
        const info = await probeVideoFile(filePath)
        return { ok: true, info }
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err)
        }
      }
    }
  )

  await createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  void stopComfyUi()
})
