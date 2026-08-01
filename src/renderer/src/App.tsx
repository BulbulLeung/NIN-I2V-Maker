import { useCallback, useEffect, useRef, useState } from 'react'
import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  type ActiveView,
  type AppSettings,
  type Flf2vGenerateDraft,
  type I2vGenerateDraft,
  type ImageItem,
  type LoopGenerateDraft,
  type SharedComfyDraft
} from './types'
import { createDefaultPromptPreset } from './defaults/i2vPromptPresets'
import { parseSidecarCaption } from './utils/sidecarCaption'
import { SettingsDialog } from './components/SettingsDialog'
import { PromptView } from './components/PromptView'
import { GenerateView } from './components/GenerateView'

interface StatusState {
  message: string
  isError: boolean
  sticky: boolean
}

export function App() {
  const [settings, setSettingsState] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [ready, setReady] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [promptImages, setPromptImages] = useState<ImageItem[]>([])
  const [status, setStatus] = useState<StatusState>({
    message: '',
    isError: false,
    sticky: false
  })

  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const statusClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const raw = await window.api.getSettings()
        let next = normalizeSettings(raw)
        if (!next.promptPresets.length) {
          const preset = createDefaultPromptPreset()
          next = {
            ...next,
            promptPresets: [preset],
            activePromptPresetId: preset.id
          }
        }
        if (!cancelled) {
          setSettingsState(next)
          setReady(true)
        }
      } catch (err) {
        if (!cancelled) {
          setSettingsState(DEFAULT_SETTINGS)
          setReady(true)
          setStatus({
            message: err instanceof Error ? err.message : String(err),
            isError: true,
            sticky: false
          })
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const persistSettings = useCallback((partial: Partial<AppSettings>) => {
    setSettingsState((prev) => {
      const merged = normalizeSettings({
        ...prev,
        ...partial,
        sharedComfy: partial.sharedComfy
          ? { ...prev.sharedComfy, ...partial.sharedComfy }
          : prev.sharedComfy,
        i2vDraft: partial.i2vDraft ? { ...prev.i2vDraft, ...partial.i2vDraft } : prev.i2vDraft,
        flf2vDraft: partial.flf2vDraft
          ? { ...prev.flf2vDraft, ...partial.flf2vDraft }
          : prev.flf2vDraft,
        loopDraft: partial.loopDraft
          ? { ...prev.loopDraft, ...partial.loopDraft }
          : prev.loopDraft
      })
      if (persistTimer.current) clearTimeout(persistTimer.current)
      persistTimer.current = setTimeout(() => {
        void window.api.setSettings(merged)
      }, 250)
      return merged
    })
  }, [])

  const onImagesChange = useCallback((images: ImageItem[]) => {
    setPromptImages((prev) => {
      if (
        prev.length === images.length &&
        prev.every((img, i) => img.path === images[i]?.path && img.hasCaption === images[i]?.hasCaption)
      ) {
        return prev
      }
      return images
    })
  }, [])

  const onStatus = useCallback(
    (msg: string, isError = false, options?: { sticky?: boolean }) => {
      if (statusClearTimer.current) clearTimeout(statusClearTimer.current)
      const sticky = Boolean(options?.sticky)
      setStatus({ message: msg, isError, sticky })
      if (!sticky && msg) {
        statusClearTimer.current = setTimeout(() => {
          setStatus((prev) =>
            prev.message === msg ? { message: '', isError: false, sticky: false } : prev
          )
        }, 5000)
      }
    },
    []
  )

  const setView = (activeView: ActiveView) => {
    persistSettings({ activeView })
    if (
      (activeView === 'i2v' || activeView === 'flf2v' || activeView === 'loop') &&
      promptImages.length === 0
    ) {
      onStatus('Open a folder in the Prompt tab to load images', true)
    }
  }

  const onSharedComfyChange = (sharedComfy: SharedComfyDraft) => {
    persistSettings({ sharedComfy })
  }

  const onI2vDraftChange = (i2vDraft: I2vGenerateDraft) => {
    persistSettings({ i2vDraft })
  }

  const onFlf2vDraftChange = (flf2vDraft: Flf2vGenerateDraft) => {
    persistSettings({ flf2vDraft })
  }

  const onLoopDraftChange = (loopDraft: LoopGenerateDraft) => {
    persistSettings({ loopDraft })
  }

  const onPromptSourceChange = useCallback(
    (imagePath: string, promptText: string) => {
      persistSettings({ promptImagePath: imagePath, promptText })
    },
    [persistSettings]
  )

  const onSelectStartImage = useCallback(
    async (imagePath: string) => {
      try {
        const text = await window.api.readCaption(imagePath)
        const parsed = parseSidecarCaption(text)
        persistSettings({ promptImagePath: imagePath, promptText: parsed.prompt })
      } catch {
        persistSettings({ promptImagePath: imagePath, promptText: '' })
      }
    },
    [persistSettings]
  )

  if (!ready) {
    return (
      <div className="app">
        <div className="app-loading">Loading…</div>
      </div>
    )
  }

  return (
    <div className="app">
      <header className="toolbar">
        <div className="toolbar-left">
          <strong className="app-brand">NIN I2V Maker</strong>
          <div className="view-switch" role="tablist" aria-label="Views">
            <button
              type="button"
              role="tab"
              className={`view-switch-seg${settings.activeView === 'prompt' ? ' active' : ''}`}
              aria-selected={settings.activeView === 'prompt'}
              onClick={() => setView('prompt')}
            >
              Prompt
            </button>
            <button
              type="button"
              role="tab"
              className={`view-switch-seg${settings.activeView === 'i2v' ? ' active' : ''}`}
              aria-selected={settings.activeView === 'i2v'}
              onClick={() => setView('i2v')}
            >
              I2V
            </button>
            <button
              type="button"
              role="tab"
              className={`view-switch-seg${settings.activeView === 'flf2v' ? ' active' : ''}`}
              aria-selected={settings.activeView === 'flf2v'}
              onClick={() => setView('flf2v')}
            >
              FLF2V
            </button>
            <button
              type="button"
              role="tab"
              className={`view-switch-seg${settings.activeView === 'loop' ? ' active' : ''}`}
              aria-selected={settings.activeView === 'loop'}
              onClick={() => setView('loop')}
            >
              LOOP
            </button>
          </div>
        </div>
        <div className="toolbar-right">
          <button type="button" onClick={() => setSettingsOpen(true)}>
            Settings
          </button>
        </div>
      </header>

      <div
        className="app-view-slot"
        style={{ display: settings.activeView === 'prompt' ? undefined : 'none' }}
        aria-hidden={settings.activeView !== 'prompt'}
      >
        <PromptView
          settings={settings}
          onSettingsChange={persistSettings}
          onStatus={onStatus}
          onPromptSourceChange={onPromptSourceChange}
          onImagesChange={onImagesChange}
        />
      </div>

      {settings.activeView === 'flf2v' ? (
        <GenerateView
          panel="flf2v"
          settings={settings}
          sharedComfy={settings.sharedComfy}
          draft={settings.flf2vDraft}
          startImagePath={settings.promptImagePath}
          promptText={settings.promptText}
          promptImages={promptImages}
          onSelectStartImage={onSelectStartImage}
          onSharedComfyChange={onSharedComfyChange}
          onDraftChange={(d) => onFlf2vDraftChange(d as Flf2vGenerateDraft)}
          onStatus={onStatus}
        />
      ) : null}

      {settings.activeView === 'loop' ? (
        <GenerateView
          panel="loop"
          settings={settings}
          sharedComfy={settings.sharedComfy}
          draft={settings.loopDraft}
          startImagePath={settings.promptImagePath}
          promptText={settings.promptText}
          promptImages={promptImages}
          onSelectStartImage={onSelectStartImage}
          onSharedComfyChange={onSharedComfyChange}
          onDraftChange={(d) => onLoopDraftChange(d as LoopGenerateDraft)}
          onStatus={onStatus}
        />
      ) : null}

      {settings.activeView === 'i2v' ? (
        <GenerateView
          panel="i2v"
          settings={settings}
          sharedComfy={settings.sharedComfy}
          draft={settings.i2vDraft}
          startImagePath={settings.promptImagePath}
          promptText={settings.promptText}
          promptImages={promptImages}
          onSelectStartImage={onSelectStartImage}
          onSharedComfyChange={onSharedComfyChange}
          onDraftChange={(d) => onI2vDraftChange(d as I2vGenerateDraft)}
          onStatus={onStatus}
        />
      ) : null}

      <SettingsDialog
        settings={settings}
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSave={persistSettings}
      />

      <footer
        className={`system-message-bar${status.isError ? ' is-error' : ''}${status.message ? ' has-message' : ''}`}
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        <span
          className={`system-message-bar-text${status.isError ? ' is-error' : ''}${!status.message ? ' is-idle' : ''}`}
        >
          {status.message || 'Ready'}
        </span>
      </footer>
    </div>
  )
}
