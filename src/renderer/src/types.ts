import {
  createDefaultPromptPreset,
  DEFAULT_PROMPT_PRESET_ID
} from './defaults/i2vPromptPresets'
import {
  DEFAULT_FLF2V_GENERATE_DRAFT,
  DEFAULT_I2V_GENERATE_DRAFT,
  DEFAULT_LOOP_GENERATE_DRAFT,
  DEFAULT_SHARED_COMFY,
  DEFAULT_UPSCALE_GENERATE_DRAFT,
  migrateGenerateSettings,
  normalizeActiveView,
  normalizeActiveViewAndPanel,
  normalizeFlf2vGenerateDraft,
  normalizeI2vGenerateDraft,
  normalizeSharedComfyDraft,
  normalizeUpscaleGenerateDraft,
  normalizeVideoGenPanel,
  pythonInstallPathFromDownloadFolder,
  type ActiveView,
  type Flf2vGenerateDraft,
  type FlfMode,
  type I2vGenerateDraft,
  type LoopGenerateDraft,
  type SharedComfyDraft,
  type UpscaleGenerateDraft,
  type ExtraLoraEntry,
  type VideoGenPanel,
  type Wan22VideoMode,
  type VideoSaveBitDepth,
  type VideoSaveCodec,
  type VideoSaveFormat
} from './defaults/i2vGenerate'
import { join } from './utils/pathJoin'

export type {
  ActiveView,
  ExtraLoraEntry,
  Flf2vGenerateDraft,
  FlfMode,
  I2vGenerateDraft,
  LoopGenerateDraft,
  SharedComfyDraft,
  UpscaleGenerateDraft,
  VideoGenPanel,
  VideoSaveBitDepth,
  VideoSaveCodec,
  VideoSaveFormat,
  Wan22VideoMode
}
export {
  DEFAULT_FLF2V_GENERATE_DRAFT,
  DEFAULT_I2V_GENERATE_DRAFT,
  DEFAULT_LOOP_GENERATE_DRAFT,
  DEFAULT_SHARED_COMFY,
  DEFAULT_UPSCALE_GENERATE_DRAFT,
  DEFAULT_VIDEO_CRF,
  VIDEO_CRF_MAX,
  VIDEO_CRF_MIN,
  VIDEO_SAVE_BIT_DEPTH_OPTIONS,
  VIDEO_SAVE_CODEC_OPTIONS,
  VIDEO_SAVE_FORMAT_OPTIONS,
  framesFromSeconds,
  migrateGenerateSettings,
  normalizeActiveView,
  normalizeActiveViewAndPanel,
  normalizeFlf2vGenerateDraft,
  normalizeI2vGenerateDraft,
  normalizeSharedComfyDraft,
  normalizeUpscaleGenerateDraft,
  normalizeVideoGenPanel,
  pythonInstallPathFromDownloadFolder
} from './defaults/i2vGenerate'

export type TranslationProvider = 'lmstudio' | 'ollama'
export type UiGpuMode = 'auto' | 'onboard' | 'software'
export type ListViewMode = 'list' | 'thumbs'

export interface ResourceGpuVramApp {
  pid: number
  name: string
  memUsedMiB: number
  killable: boolean
}

export interface ResourceGpuStats {
  id: string
  name: string
  utilPercent: number
  memUsedMiB: number
  memTotalMiB: number
  tempC: number | null
  powerDrawW: number | null
  powerLimitW: number | null
  apps: ResourceGpuVramApp[]
}

export interface ResourceStats {
  cpuName: string
  cpuPercent: number
  ramUsedBytes: number
  ramTotalBytes: number
  gpu: ResourceGpuStats | null
}

export interface PromptPreset {
  id: string
  name: string
  prompt: string
}

export interface ImageItem {
  path: string
  name: string
  hasCaption: boolean
}

export interface LanguageOption {
  code: string
  label: string
}

export const LANGUAGES: LanguageOption[] = [
  { code: 'zh-TW', label: '繁體中文' },
  { code: 'zh-CN', label: '简体中文' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' },
  { code: 'es', label: 'Español' },
  { code: 'it', label: 'Italiano' },
  { code: 'pt', label: 'Português' },
  { code: 'ru', label: 'Русский' }
]

export interface AppSettings {
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
  listViewMode: ListViewMode
  thumbnailWidth: number
  activeView: ActiveView
  /** Sub-mode inside Video Gen tab (I2V / FLF2V / LOOP). */
  videoGenPanel: VideoGenPanel
  uiGpuMode: UiGpuMode
  disableUiGpu: boolean
  pythonPath: string
  downloadFolder: string
  /** Image currently selected in Prompt view (start / loop frame for generate panels). */
  promptImagePath: string
  /** English prompt from Prompt view for that image. */
  promptText: string
  /** When generating I2V prompt, include embedded image positive prompt from file metadata. */
  useImagePrompt: boolean
  sharedComfy: SharedComfyDraft
  i2vDraft: I2vGenerateDraft
  flf2vDraft: Flf2vGenerateDraft
  loopDraft: LoopGenerateDraft
  upscaleDraft: UpscaleGenerateDraft
}

const defaultPreset = createDefaultPromptPreset()

export const DEFAULT_SETTINGS: AppSettings = {
  provider: 'lmstudio',
  lmStudioBaseUrl: 'http://localhost:1234/v1',
  ollamaBaseUrl: 'http://localhost:11434',
  model: '',
  targetLanguage: 'zh-TW',
  lastFolder: null,
  imageFolders: [],
  promptPresets: [defaultPreset],
  activePromptPresetId: DEFAULT_PROMPT_PRESET_ID,
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
  i2vDraft: { ...DEFAULT_I2V_GENERATE_DRAFT },
  flf2vDraft: { ...DEFAULT_FLF2V_GENERATE_DRAFT },
  loopDraft: { ...DEFAULT_LOOP_GENERATE_DRAFT },
  upscaleDraft: { ...DEFAULT_UPSCALE_GENERATE_DRAFT }
}

function normalizeUiGpuMode(raw: unknown): UiGpuMode {
  if (raw === 'software' || raw === 'onboard' || raw === 'auto') return raw
  return 'auto'
}

function normalizeListViewMode(raw: unknown): ListViewMode {
  if (raw === 'thumbs' || raw === 'thumbnails') return 'thumbs'
  return 'list'
}

export function normalizeSettings(
  raw: Partial<AppSettings> | Record<string, unknown>
): AppSettings {
  const r = raw as Partial<AppSettings> & Record<string, unknown>
  const uiGpuMode = normalizeUiGpuMode(r.uiGpuMode ?? (r.disableUiGpu ? 'software' : 'auto'))
  const presets =
    Array.isArray(r.promptPresets) && r.promptPresets.length > 0
      ? (r.promptPresets as PromptPreset[])
      : [createDefaultPromptPreset()]
  const activeId =
    typeof r.activePromptPresetId === 'string' &&
    presets.some((p) => p.id === r.activePromptPresetId)
      ? r.activePromptPresetId
      : presets[0].id

  const migrated = migrateGenerateSettings(r)
  const viewAndPanel = normalizeActiveViewAndPanel(r.activeView)
  const videoGenPanel =
    viewAndPanel.videoGenPanel ??
    normalizeVideoGenPanel(r.videoGenPanel)

  return {
    ...DEFAULT_SETTINGS,
    ...r,
    provider: r.provider === 'ollama' ? 'ollama' : 'lmstudio',
    lmStudioBaseUrl:
      typeof r.lmStudioBaseUrl === 'string' && r.lmStudioBaseUrl.trim()
        ? r.lmStudioBaseUrl
        : DEFAULT_SETTINGS.lmStudioBaseUrl,
    ollamaBaseUrl:
      typeof r.ollamaBaseUrl === 'string' && r.ollamaBaseUrl.trim()
        ? r.ollamaBaseUrl
        : DEFAULT_SETTINGS.ollamaBaseUrl,
    model: typeof r.model === 'string' ? r.model : '',
    targetLanguage:
      typeof r.targetLanguage === 'string' && r.targetLanguage.trim()
        ? r.targetLanguage
        : 'zh-TW',
    lastFolder: typeof r.lastFolder === 'string' ? r.lastFolder : null,
    imageFolders: Array.isArray(r.imageFolders)
      ? (r.imageFolders as string[]).filter((x) => typeof x === 'string' && x.trim())
      : [],
    promptPresets: presets,
    activePromptPresetId: activeId,
    sidebarWidth:
      typeof r.sidebarWidth === 'number' && r.sidebarWidth >= 160 ? r.sidebarWidth : 260,
    rightPaneWidth:
      typeof r.rightPaneWidth === 'number' && r.rightPaneWidth >= 240
        ? r.rightPaneWidth
        : 380,
    listViewMode: normalizeListViewMode(r.listViewMode),
    thumbnailWidth:
      typeof r.thumbnailWidth === 'number' && r.thumbnailWidth >= 64
        ? r.thumbnailWidth
        : 120,
    activeView: viewAndPanel.activeView,
    videoGenPanel,
    uiGpuMode,
    disableUiGpu: uiGpuMode === 'software',
    pythonPath: typeof r.pythonPath === 'string' ? r.pythonPath : '',
    downloadFolder: typeof r.downloadFolder === 'string' ? r.downloadFolder : '',
    promptImagePath: typeof r.promptImagePath === 'string' ? r.promptImagePath : '',
    promptText: typeof r.promptText === 'string' ? r.promptText : '',
    useImagePrompt: typeof r.useImagePrompt === 'boolean' ? r.useImagePrompt : false,
    sharedComfy: migrated.sharedComfy,
    i2vDraft: migrated.i2vDraft,
    flf2vDraft: migrated.flf2vDraft,
    loopDraft: migrated.loopDraft,
    upscaleDraft: migrated.upscaleDraft
  }
}

export function modelsRootFromDownloadFolder(downloadFolder: string): string | undefined {
  const trimmed = downloadFolder.trim()
  return trimmed ? join(trimmed, 'models') : undefined
}
