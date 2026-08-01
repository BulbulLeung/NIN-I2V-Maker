import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

export interface ImageItem {
  path: string
  name: string
  hasCaption: boolean
}

export type TranslationProvider = 'lmstudio' | 'ollama'
export type UiGpuMode = 'auto' | 'software' | 'onboard'
export type ActiveView = 'prompt' | 'i2v' | 'flf2v' | 'loop'
export type FlfMode = 'flf2v' | 'wanfun_inpaint'

export interface PromptPreset {
  id: string
  name: string
  prompt: string
}

export interface SharedComfyDraft {
  comfyUiBatPath: string
  ditModelFolder: string
  highDitPath: string
  lowDitPath: string
  speedLoraFolder: string
  wan22LoraFolder: string
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

export interface ExtraLoraEntry {
  id: string
  path: string
  strength: number
  enabled: boolean
}

export interface VideoGenerateParams {
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

export type I2vGenerateDraft = VideoGenerateParams

export interface Flf2vGenerateDraft extends VideoGenerateParams {
  endImagePath: string
  flfMode: FlfMode
}

export type LoopGenerateDraft = Flf2vGenerateDraft

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
  listViewMode: 'list' | 'thumbs'
  thumbnailWidth: number
  activeView: ActiveView
  uiGpuMode: UiGpuMode
  disableUiGpu: boolean
  pythonPath: string
  downloadFolder: string
  promptImagePath: string
  promptText: string
  sharedComfy: SharedComfyDraft
  i2vDraft: I2vGenerateDraft
  flf2vDraft: Flf2vGenerateDraft
  loopDraft: LoopGenerateDraft
  windowWidth: number
  windowHeight: number
  windowX: number | null
  windowY: number | null
  windowMaximized: boolean
}

export interface ModelFileItem {
  name: string
  path: string
}

export interface GalleryVideoItem {
  path: string
  name: string
  mtimeMs: number
}

export interface GalleryVideoProbeInfo {
  path: string
  name: string
  sizeBytes: number
  width: number | null
  height: number | null
  codec: string | null
  bitDepth: number | null
  container: string | null
  seed: number | null
}

const api = {
  openFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:openFolder'),

  openFile: (opts?: {
    title?: string
    filters?: { name: string; extensions: string[] }[]
  }): Promise<string | null> => ipcRenderer.invoke('dialog:openFile', opts),

  openPathInExplorer: (targetPath: string): Promise<{ ok: boolean; error?: string; path?: string }> =>
    ipcRenderer.invoke('shell:openPath', targetPath),

  showItemInFolder: (fullPath: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('shell:showItemInFolder', fullPath),

  listImages: (dir: string): Promise<ImageItem[]> => ipcRenderer.invoke('fs:listImages', dir),

  readCaption: (imagePath: string): Promise<string> =>
    ipcRenderer.invoke('fs:readCaption', imagePath),

  writeCaption: (imagePath: string, text: string): Promise<boolean> =>
    ipcRenderer.invoke('fs:writeCaption', imagePath, text),

  readImageBase64: (imagePath: string): Promise<{ mimeType: string; base64: string }> =>
    ipcRenderer.invoke('fs:readImageBase64', imagePath),

  pathExists: (targetPath: string): Promise<boolean> =>
    ipcRenderer.invoke('fs:pathExists', targetPath),

  listModelFiles: (folder: string): Promise<ModelFileItem[]> =>
    ipcRenderer.invoke('fs:listModelFiles', folder),

  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),

  setSettings: (settings: Partial<AppSettings>): Promise<boolean> =>
    ipcRenderer.invoke('settings:set', settings),

  listGpuDevices: (): Promise<{ id: string; label: string }[]> =>
    ipcRenderer.invoke('gpu:listDevices'),

  getResourceStats: (deviceId?: string): Promise<{
    cpuName: string
    cpuPercent: number
    ramUsedBytes: number
    ramTotalBytes: number
    gpu: null | {
      id: string
      name: string
      utilPercent: number
      memUsedMiB: number
      memTotalMiB: number
      tempC: number | null
      powerDrawW: number | null
      powerLimitW: number | null
      apps: { pid: number; name: string; memUsedMiB: number; killable: boolean }[]
    }
  }> => ipcRenderer.invoke('system:getResourceStats', deviceId),

  killProcess: (pid: number): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('system:killProcess', pid),

  defaultDownloadFolder: (): Promise<string> => ipcRenderer.invoke('download:defaultFolder'),

  probePython: (
    pythonPath?: string
  ): Promise<{
    status: 'ready' | 'missingPython' | 'missingPackages' | 'error'
    message: string
    pythonPath?: string
    version?: string
    cuda?: boolean
    triton?: boolean
    sageattn?: boolean
    sageattnVersion?: string
    missing?: string[]
  }> => ipcRenderer.invoke('python:probe', pythonPath),

  installPython: (opts?: {
    installPath?: string
  }): Promise<{ ok: boolean; pythonPath?: string; message: string }> =>
    ipcRenderer.invoke('python:install', opts),

  cancelPythonInstall: (): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('python:cancelInstall'),

  onPythonInstallProgress: (
    cb: (payload: { stage: string; message: string; pct: number }) => void
  ) => {
    const listener = (
      _e: IpcRendererEvent,
      payload: { stage: string; message: string; pct: number }
    ) => cb(payload)
    ipcRenderer.on('python:installProgress', listener)
    return () => ipcRenderer.removeListener('python:installProgress', listener)
  },

  probeComfyBat: (
    batPath?: string
  ): Promise<{ ok: boolean; message: string; installRoot?: string }> =>
    ipcRenderer.invoke('comfy:probeBat', batPath),

  installComfyUi: (opts?: {
    downloadFolder?: string
    pythonPath?: string
  }): Promise<{ ok: boolean; batPath?: string; message: string; installRoot?: string }> =>
    ipcRenderer.invoke('comfy:install', opts),

  cancelComfyInstall: (): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('comfy:cancelInstall'),

  onComfyInstallProgress: (
    cb: (payload: { stage: string; message: string; pct: number }) => void
  ) => {
    const listener = (
      _e: IpcRendererEvent,
      payload: { stage: string; message: string; pct: number }
    ) => cb(payload)
    ipcRenderer.on('comfy:installProgress', listener)
    return () => ipcRenderer.removeListener('comfy:installProgress', listener)
  },

  startComfyUi: (opts: {
    batPath: string
    pythonPath?: string
    modelsRoot?: string
    loraFolders?: string[]
    ditFolders?: string[]
    vaeFolders?: string[]
    clipFolders?: string[]
    useSageAttention?: boolean
  }): Promise<{ ok: boolean; error?: string; alreadyRunning?: boolean }> =>
    ipcRenderer.invoke('comfy:start', opts),

  stopComfyUi: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('comfy:stop'),

  comfyStatus: (): Promise<{
    running: boolean
    pid?: number
    online: boolean
    installRoot?: string
    outputDir?: string
  }> => ipcRenderer.invoke('comfy:status'),

  comfyHttpRequest: (opts: {
    url: string
    method?: string
    headers?: Record<string, string>
    body?: string
    timeoutMs?: number
  }): Promise<{ ok: boolean; status: number; text: string; error?: string }> =>
    ipcRenderer.invoke('comfy:httpRequest', opts),

  comfyProgressConnect: (opts: {
    baseUrl?: string
    clientId: string
  }): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('comfy:progressConnect', opts),

  comfyProgressDisconnect: (): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('comfy:progressDisconnect'),

  onComfyProgress: (
    cb: (payload: {
      type: string
      data?: {
        value?: number
        max?: number
        node?: string | null
        prompt_id?: string
      }
    }) => void
  ) => {
    const listener = (
      _e: IpcRendererEvent,
      payload: {
        type: string
        data?: {
          value?: number
          max?: number
          node?: string | null
          prompt_id?: string
        }
      }
    ) => cb(payload)
    ipcRenderer.on('comfy:progress', listener)
    return () => ipcRenderer.removeListener('comfy:progress', listener)
  },

  comfyResolveImagePath: (img: {
    filename: string
    subfolder?: string
    type?: string
  }): Promise<{ ok: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke('comfy:resolveImagePath', img),

  comfyGetOutputDir: (): Promise<{ ok: boolean; path: string }> =>
    ipcRenderer.invoke('comfy:getOutputDir'),

  comfyUploadImage: (opts: {
    imagePath: string
    baseUrl?: string
  }): Promise<{ name: string; subfolder: string; type: string }> =>
    ipcRenderer.invoke('comfy:uploadImage', opts),

  onComfyLog: (cb: (payload: { line: string; stream: string }) => void) => {
    const listener = (_e: IpcRendererEvent, payload: { line: string; stream: string }) =>
      cb(payload)
    ipcRenderer.on('comfy:log', listener)
    return () => ipcRenderer.removeListener('comfy:log', listener)
  },

  gallerySaveVideo: (opts: {
    sourcePath: string
    outputFolder: string
    fileName?: string
    seed?: number
  }): Promise<{ ok: boolean; path?: string; dir?: string; error?: string }> =>
    ipcRenderer.invoke('gallery:saveVideo', opts),

  galleryListVideos: (opts: {
    outputFolder: string
  }): Promise<{
    ok: boolean
    error?: string
    videos: GalleryVideoItem[]
  }> => ipcRenderer.invoke('gallery:listVideos', opts),

  galleryProbeVideo: (opts: {
    path: string
  }): Promise<{
    ok: boolean
    error?: string
    info?: GalleryVideoProbeInfo
  }> => ipcRenderer.invoke('gallery:probeVideo', opts),

  toLocalUrl: (filePath: string): string => {
    const normalized = filePath.replace(/\\/g, '/')
    const encoded = normalized.split('/').map((seg) => encodeURIComponent(seg)).join('/')
    return `local-file://local/${encoded}`
  }
}

contextBridge.exposeInMainWorld('api', api)

export type ElectronApi = typeof api

declare global {
  interface Window {
    api: typeof api
  }
}
