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
import { setLocalAiBlocked } from './services/localAiGate'

interface StatusState {
  message: string
  isError: boolean
  sticky: boolean
}

function folderLabel(path: string): string {
  const norm = path.replace(/\\/g, '/')
  const i = norm.lastIndexOf('/')
  return i >= 0 ? path.slice(i + 1) : path
}

export function App() {
  const [settings, setSettingsState] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [ready, setReady] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [folderMenuOpen, setFolderMenuOpen] = useState(false)
  const [videoGenerating, setVideoGenerating] = useState(false)
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
  const folderMenuRef = useRef<HTMLDivElement | null>(null)

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
      onStatus('Add a folder from the toolbar to load images', true)
    }
  }

  useEffect(() => {
    if (!folderMenuOpen) return
    const onDocClick = (e: MouseEvent) => {
      if (!folderMenuRef.current?.contains(e.target as Node)) {
        setFolderMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [folderMenuOpen])

  const addFolder = async () => {
    const dir = await window.api.openFolder()
    if (!dir) return
    const folders = settings.imageFolders.includes(dir)
      ? settings.imageFolders
      : [...settings.imageFolders, dir]
    persistSettings({
      imageFolders: folders,
      lastFolder: dir
    })
    setFolderMenuOpen(false)
    onStatus(`Opened folder: ${folderLabel(dir)}`)
  }

  const selectFolder = (dir: string) => {
    persistSettings({ lastFolder: dir })
    setFolderMenuOpen(false)
  }

  const removeSelectedFolder = () => {
    const current = settings.lastFolder
    if (!current) {
      onStatus('No folder selected to remove', true)
      return
    }
    const folders = settings.imageFolders.filter((d) => d !== current)
    const nextFolder = folders[0] ?? null
    const clearPrompt =
      Boolean(settings.promptImagePath) &&
      (settings.promptImagePath.startsWith(current + '\\') ||
        settings.promptImagePath.startsWith(current + '/') ||
        settings.promptImagePath === current)
    persistSettings({
      imageFolders: folders,
      lastFolder: nextFolder,
      ...(clearPrompt ? { promptImagePath: '', promptText: '' } : {})
    })
    setFolderMenuOpen(false)
    onStatus(
      nextFolder
        ? `Removed folder: ${folderLabel(current)} → ${folderLabel(nextFolder)}`
        : `Removed folder: ${folderLabel(current)}`
    )
  }

  const onVideoGeneratingChange = useCallback((generating: boolean) => {
    setVideoGenerating(generating)
    setLocalAiBlocked(generating)
  }, [])

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
          <div className="toolbar-folder-controls" ref={folderMenuRef}>
            <div className="toolbar-dataset">
              <button
                type="button"
                className="toolbar-dataset-trigger"
                onClick={() => setFolderMenuOpen((v) => !v)}
                title={settings.lastFolder ?? 'No folder'}
              >
                <span className="toolbar-dataset-label">
                  {settings.lastFolder
                    ? folderLabel(settings.lastFolder)
                    : 'Select folder'}
                </span>
                ▾
              </button>
              {folderMenuOpen ? (
                <ul className="toolbar-dataset-menu">
                  {settings.imageFolders.length === 0 ? (
                    <li>
                      <button type="button" className="toolbar-dataset-option" disabled>
                        No folders yet
                      </button>
                    </li>
                  ) : (
                    settings.imageFolders.map((dir) => (
                      <li key={dir}>
                        <button
                          type="button"
                          className={`toolbar-dataset-option${
                            dir === settings.lastFolder ? ' active' : ''
                          }`}
                          onClick={() => selectFolder(dir)}
                          title={dir}
                        >
                          {folderLabel(dir)}
                        </button>
                      </li>
                    ))
                  )}
                </ul>
              ) : null}
            </div>
            <button
              type="button"
              className="toolbar-folder-icon-btn"
              title="Add folder"
              aria-label="Add folder"
              onClick={() => void addFolder()}
            >
              +
            </button>
            <button
              type="button"
              className="toolbar-folder-icon-btn"
              title="Remove selected folder"
              aria-label="Remove selected folder"
              disabled={!settings.lastFolder}
              onClick={removeSelectedFolder}
            >
              −
            </button>
          </div>
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
          active={settings.activeView === 'prompt'}
          videoGenerating={videoGenerating}
          onSettingsChange={persistSettings}
          onStatus={onStatus}
          onPromptSourceChange={onPromptSourceChange}
          onImagesChange={onImagesChange}
        />
      </div>

      <div
        className="app-view-slot"
        style={{ display: settings.activeView === 'i2v' ? undefined : 'none' }}
        aria-hidden={settings.activeView !== 'i2v'}
      >
        <GenerateView
          panel="i2v"
          active={settings.activeView === 'i2v'}
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
          videoGenerating={videoGenerating}
          onVideoGeneratingChange={onVideoGeneratingChange}
        />
      </div>

      <div
        className="app-view-slot"
        style={{ display: settings.activeView === 'flf2v' ? undefined : 'none' }}
        aria-hidden={settings.activeView !== 'flf2v'}
      >
        <GenerateView
          panel="flf2v"
          active={settings.activeView === 'flf2v'}
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
          videoGenerating={videoGenerating}
          onVideoGeneratingChange={onVideoGeneratingChange}
        />
      </div>

      <div
        className="app-view-slot"
        style={{ display: settings.activeView === 'loop' ? undefined : 'none' }}
        aria-hidden={settings.activeView !== 'loop'}
      >
        <GenerateView
          panel="loop"
          active={settings.activeView === 'loop'}
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
          videoGenerating={videoGenerating}
          onVideoGeneratingChange={onVideoGeneratingChange}
        />
      </div>

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
