import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import type { AppSettings, SharedComfyDraft } from '../types'
import { modelsRootFromDownloadFolder } from '../types'
import { parentDir, probeComfyOnline } from '../services/comfyI2v'

export type ComfyStartFolders = {
  ditFolders?: string[]
  vaeFolders?: string[]
  clipFolders?: string[]
  loraFolders?: string[]
  upscaleFolders?: string[]
  frameInterpFolders?: string[]
}

type StatusFn = (msg: string, isError?: boolean, options?: { sticky?: boolean }) => void

interface ComfyUiContextValue {
  comfyOnline: boolean
  comfyBusy: boolean
  setComfyOnline: (online: boolean) => void
  setComfyBusy: (busy: boolean) => void
  ensureComfyOnline: (folders?: ComfyStartFolders) => Promise<boolean>
  startComfy: () => Promise<void>
  stopComfy: () => Promise<void>
}

const ComfyUiContext = createContext<ComfyUiContextValue | null>(null)

function uniqueDirs(paths: string[], extraDirs: string[] = []): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const addDir = (dir: string) => {
    const trimmed = dir.trim()
    if (!trimmed) return
    const key = trimmed.replace(/\\/g, '/').toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    out.push(trimmed)
  }
  for (const d of extraDirs) addDir(d)
  for (const p of paths) addDir(parentDir(p))
  return out
}

function defaultStartFolders(settings: AppSettings): Required<ComfyStartFolders> {
  const s = settings.sharedComfy
  const drafts = [settings.i2vDraft, settings.flf2vDraft, settings.loopDraft]
  const extraPaths = drafts.flatMap((d) => [
    ...(d.extraLorasHigh || []).map((e) => e.path),
    ...(d.extraLorasLow || []).map((e) => e.path)
  ])
  const loraPaths = drafts.flatMap((d) => [d.loraHighPath, d.loraLowPath, ...extraPaths])
  return {
    ditFolders: uniqueDirs([s.highDitPath, s.lowDitPath], [s.ditModelFolder]),
    vaeFolders: uniqueDirs([s.vaePath]),
    clipFolders: uniqueDirs([s.clipPath]),
    loraFolders: uniqueDirs(loraPaths, [s.speedLoraFolder, s.wan22LoraFolder]),
    upscaleFolders: uniqueDirs([settings.upscaleDraft.upscaleModelPath], [s.upscaleModelFolder]),
    frameInterpFolders: uniqueDirs(
      [settings.upscaleDraft.interpolationModelPath],
      [s.frameInterpModelFolder]
    )
  }
}

interface ProviderProps {
  settings: AppSettings
  onStatus: StatusFn
  children: ReactNode
}

export function ComfyUiProvider({ settings, onStatus, children }: ProviderProps) {
  const [comfyOnline, setComfyOnline] = useState(false)
  const [comfyBusy, setComfyBusy] = useState(false)
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const onStatusRef = useRef(onStatus)
  onStatusRef.current = onStatus

  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      try {
        const online = await probeComfyOnline()
        if (!cancelled) setComfyOnline(online)
      } catch {
        if (!cancelled) setComfyOnline(false)
      }
    }
    void tick()
    const id = window.setInterval(() => void tick(), 4000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [])

  const ensureComfyOnline = useCallback(async (folders?: ComfyStartFolders): Promise<boolean> => {
    if (await probeComfyOnline()) {
      setComfyOnline(true)
      return true
    }
    const current = settingsRef.current
    const shared: SharedComfyDraft = current.sharedComfy
    const bat = shared.comfyUiBatPath.trim()
    if (!bat) {
      onStatusRef.current('Set ComfyUI launch bat in Settings → ComfyUI', true)
      return false
    }
    setComfyBusy(true)
    onStatusRef.current('Starting ComfyUI…', false, { sticky: true })
    try {
      const defaults = defaultStartFolders(current)
      const result = await window.api.startComfyUi({
        batPath: bat,
        pythonPath: current.pythonPath.trim() || undefined,
        modelsRoot: modelsRootFromDownloadFolder(current.downloadFolder),
        ditFolders: folders?.ditFolders ?? defaults.ditFolders,
        vaeFolders: folders?.vaeFolders ?? defaults.vaeFolders,
        clipFolders: folders?.clipFolders ?? defaults.clipFolders,
        loraFolders: folders?.loraFolders ?? defaults.loraFolders,
        upscaleFolders: folders?.upscaleFolders ?? defaults.upscaleFolders,
        frameInterpFolders: folders?.frameInterpFolders ?? defaults.frameInterpFolders,
        useSageAttention: shared.useSageAttention
      })
      if (!result.ok) {
        onStatusRef.current(result.error || 'Failed to start ComfyUI', true)
        return false
      }
      for (let i = 0; i < 60; i++) {
        if (await probeComfyOnline()) {
          setComfyOnline(true)
          onStatusRef.current(result.alreadyRunning ? 'ComfyUI already online' : 'ComfyUI is online')
          return true
        }
        await new Promise((r) => setTimeout(r, 1000))
      }
      onStatusRef.current('ComfyUI started but did not become ready in time', true)
      return false
    } catch (err) {
      onStatusRef.current(err instanceof Error ? err.message : String(err), true)
      return false
    } finally {
      setComfyBusy(false)
    }
  }, [])

  const startComfy = useCallback(async () => {
    await ensureComfyOnline()
  }, [ensureComfyOnline])

  const stopComfy = useCallback(async () => {
    setComfyBusy(true)
    try {
      await window.api.stopComfyUi()
      setComfyOnline(false)
      onStatusRef.current('ComfyUI stopped')
    } catch (err) {
      onStatusRef.current(err instanceof Error ? err.message : String(err), true)
    } finally {
      setComfyBusy(false)
    }
  }, [])

  const value = useMemo<ComfyUiContextValue>(
    () => ({
      comfyOnline,
      comfyBusy,
      setComfyOnline,
      setComfyBusy,
      ensureComfyOnline,
      startComfy,
      stopComfy
    }),
    [comfyOnline, comfyBusy, ensureComfyOnline, startComfy, stopComfy]
  )

  return <ComfyUiContext.Provider value={value}>{children}</ComfyUiContext.Provider>
}

export function useComfyUi(): ComfyUiContextValue {
  const ctx = useContext(ComfyUiContext)
  if (!ctx) throw new Error('useComfyUi must be used within ComfyUiProvider')
  return ctx
}

interface ToolbarControlsProps {
  locked?: boolean
}

export function ComfyUiToolbarControls({ locked = false }: ToolbarControlsProps) {
  const { comfyOnline, comfyBusy, startComfy, stopComfy } = useComfyUi()
  const disabled = comfyBusy || locked

  return (
    <div className="toolbar-comfy-row" title={comfyOnline ? 'ComfyUI online' : 'ComfyUI offline'}>
      <span className={`lora-test-comfy-dot${comfyOnline ? ' online' : ''}`} />
      <span className="lora-test-comfy-label">
        ComfyUI {comfyOnline ? 'online' : 'offline'}
      </span>
      {comfyOnline ? (
        <button type="button" disabled={disabled} onClick={() => void stopComfy()}>
          Stop
        </button>
      ) : (
        <button type="button" disabled={disabled} onClick={() => void startComfy()}>
          Start
        </button>
      )}
    </div>
  )
}

/** Shared helper for views that still need draft-specific model folder lists. */
export { uniqueDirs }
