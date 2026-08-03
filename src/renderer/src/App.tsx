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
  type SharedComfyDraft,
  type FaceDetailerDraft,
  type UpscaleGenerateDraft,
  type VideoGenPanel
} from './types'
import { createDefaultPromptPresets } from './defaults/i2vPromptPresets'
import { parseSidecarCaption } from './utils/sidecarCaption'
import { SettingsDialog, type SettingsTab } from './components/SettingsDialog'
import { ComfyUiProvider, ComfyUiToolbarControls } from './components/ComfyUiContext'
import { PromptView } from './components/PromptView'
import { SharedGenerateGalleryProvider } from './components/SharedGenerateGalleryContext'
import { VideoGenView } from './components/VideoGenView'
import { UpscaleView } from './components/UpscaleView'
import { FaceDetailerView } from './components/FaceDetailerView'
import { setLocalAiBlocked } from './services/localAiGate'
import {
  firstIncompleteTab,
  hasIncompleteSetup,
  type SetupSettingsTab
} from './utils/setupCompleteness'

interface StatusState {
  message: string
  isError: boolean
}

interface StatusLogEntry {
  id: number
  message: string
  isError: boolean
  at: number
}

const STATUS_LOG_MAX = 200

function folderLabel(path: string): string {
  const norm = path.replace(/\\/g, '/')
  const i = norm.lastIndexOf('/')
  return i >= 0 ? path.slice(i + 1) : path
}

function formatStatusLogTime(at: number): string {
  const d = new Date(at)
  return d.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  })
}

export function App() {
  const [settings, setSettingsState] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [ready, setReady] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsTab | null>(null)
  const [folderMenuOpen, setFolderMenuOpen] = useState(false)
  const [statusLogOpen, setStatusLogOpen] = useState(false)
  const [videoGenerating, setVideoGenerating] = useState(false)
  const [promptImages, setPromptImages] = useState<ImageItem[]>([])
  const [status, setStatus] = useState<StatusState>({
    message: '',
    isError: false
  })
  const [statusLog, setStatusLog] = useState<StatusLogEntry[]>([])

  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const statusLogIdRef = useRef(0)
  const folderMenuRef = useRef<HTMLDivElement | null>(null)
  const statusLogPanelRef = useRef<HTMLDivElement | null>(null)
  const statusLogListRef = useRef<HTMLUListElement | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const raw = await window.api.getSettings()
        let next = normalizeSettings(raw as unknown as Record<string, unknown>)
        if (!next.promptPresets.length) {
          const presets = createDefaultPromptPresets()
          next = {
            ...next,
            promptPresets: presets,
            activePromptPresetId: presets[0].id
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
          const message = err instanceof Error ? err.message : String(err)
          setStatus({ message, isError: true })
          statusLogIdRef.current += 1
          setStatusLog([
            {
              id: statusLogIdRef.current,
              message,
              isError: true,
              at: Date.now()
            }
          ])
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
          : prev.loopDraft,
        upscaleDraft: partial.upscaleDraft
          ? { ...prev.upscaleDraft, ...partial.upscaleDraft }
          : prev.upscaleDraft,
        faceDetailerDraft: partial.faceDetailerDraft
          ? { ...prev.faceDetailerDraft, ...partial.faceDetailerDraft }
          : prev.faceDetailerDraft
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
    (msg: string, isError = false, _options?: { sticky?: boolean }) => {
      // sticky is accepted for callers but ignored: messages stay until overwritten.
      setStatus({ message: msg, isError })
      if (!msg) return
      statusLogIdRef.current += 1
      const entry: StatusLogEntry = {
        id: statusLogIdRef.current,
        message: msg,
        isError,
        at: Date.now()
      }
      setStatusLog((prev) => {
        const next = [...prev, entry]
        return next.length > STATUS_LOG_MAX ? next.slice(-STATUS_LOG_MAX) : next
      })
    },
    []
  )

  const setView = (activeView: ActiveView) => {
    persistSettings({ activeView })
    if (activeView === 'videoGen' && promptImages.length === 0) {
      onStatus('Add a folder from the toolbar to load images', true)
    }
  }

  const setVideoGenPanel = (videoGenPanel: VideoGenPanel) => {
    persistSettings({ activeView: 'videoGen', videoGenPanel })
    if (promptImages.length === 0) {
      onStatus('Add a folder from the toolbar to load images', true)
    }
  }

  const openSettings = useCallback((tab?: SetupSettingsTab | null) => {
    setSettingsInitialTab(tab ?? firstIncompleteTab(settingsRef.current) ?? null)
    setSettingsOpen(true)
  }, [])

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

  useEffect(() => {
    if (!statusLogOpen) return
    const onDocClick = (e: MouseEvent) => {
      if (!statusLogPanelRef.current?.contains(e.target as Node)) {
        setStatusLogOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setStatusLogOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [statusLogOpen])

  useEffect(() => {
    if (!statusLogOpen) return
    const list = statusLogListRef.current
    if (list) list.scrollTop = list.scrollHeight
  }, [statusLogOpen, statusLog])

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

  const onUpscaleDraftChange = (upscaleDraft: UpscaleGenerateDraft) => {
    persistSettings({ upscaleDraft })
  }

  const onFaceDetailerDraftChange = (faceDetailerDraft: FaceDetailerDraft) => {
    persistSettings({ faceDetailerDraft })
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
    <ComfyUiProvider settings={settings} onStatus={onStatus}>
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
              className={`view-switch-seg${settings.activeView === 'videoGen' ? ' active' : ''}`}
              aria-selected={settings.activeView === 'videoGen'}
              onClick={() => setView('videoGen')}
            >
              Video Gen
            </button>
            <button
              type="button"
              role="tab"
              className={`view-switch-seg${settings.activeView === 'upscale' ? ' active' : ''}`}
              aria-selected={settings.activeView === 'upscale'}
              onClick={() => setView('upscale')}
            >
              Upscale
            </button>
            <button
              type="button"
              role="tab"
              className={`view-switch-seg${settings.activeView === 'faceDetailer' ? ' active' : ''}`}
              aria-selected={settings.activeView === 'faceDetailer'}
              onClick={() => setView('faceDetailer')}
            >
              Face
            </button>
          </div>
          <ComfyUiToolbarControls locked={videoGenerating} />
        </div>
        <div className="toolbar-right">
          <button
            type="button"
            onClick={() => {
              setSettingsInitialTab(null)
              setSettingsOpen(true)
            }}
          >
            {hasIncompleteSetup(settings) && (
              <span className="setup-required-dot" aria-hidden="true" />
            )}
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

      <SharedGenerateGalleryProvider
        outputFolder={settings.sharedComfy.outputFolder}
        onStatus={onStatus}
      >
        <div
          className="app-view-slot"
          style={{ display: settings.activeView === 'videoGen' ? undefined : 'none' }}
          aria-hidden={settings.activeView !== 'videoGen'}
        >
          <VideoGenView
            active={settings.activeView === 'videoGen'}
            videoGenPanel={settings.videoGenPanel}
            settings={settings}
            sharedComfy={settings.sharedComfy}
            startImagePath={settings.promptImagePath}
            promptText={settings.promptText}
            promptImages={promptImages}
            onSelectStartImage={onSelectStartImage}
            onSharedComfyChange={onSharedComfyChange}
            onI2vDraftChange={onI2vDraftChange}
            onFlf2vDraftChange={onFlf2vDraftChange}
            onLoopDraftChange={onLoopDraftChange}
            onPanelChange={setVideoGenPanel}
            onStatus={onStatus}
            onOpenSettings={openSettings}
            videoGenerating={videoGenerating}
            onVideoGeneratingChange={onVideoGeneratingChange}
          />
        </div>
      </SharedGenerateGalleryProvider>

      <div
        className="app-view-slot"
        style={{ display: settings.activeView === 'upscale' ? undefined : 'none' }}
        aria-hidden={settings.activeView !== 'upscale'}
      >
        <UpscaleView
          active={settings.activeView === 'upscale'}
          settings={settings}
          sharedComfy={settings.sharedComfy}
          draft={settings.upscaleDraft}
          onSharedComfyChange={onSharedComfyChange}
          onDraftChange={onUpscaleDraftChange}
          onStatus={onStatus}
          videoGenerating={videoGenerating}
          onVideoGeneratingChange={onVideoGeneratingChange}
        />
      </div>

      <div
        className="app-view-slot"
        style={{ display: settings.activeView === 'faceDetailer' ? undefined : 'none' }}
        aria-hidden={settings.activeView !== 'faceDetailer'}
      >
        <FaceDetailerView
          active={settings.activeView === 'faceDetailer'}
          settings={settings}
          sharedComfy={settings.sharedComfy}
          draft={settings.faceDetailerDraft}
          onSharedComfyChange={onSharedComfyChange}
          onDraftChange={onFaceDetailerDraftChange}
          onStatus={onStatus}
          videoGenerating={videoGenerating}
          onVideoGeneratingChange={onVideoGeneratingChange}
        />
      </div>

      <SettingsDialog
        settings={settings}
        open={settingsOpen}
        initialTab={settingsInitialTab}
        onClose={() => {
          setSettingsOpen(false)
          setSettingsInitialTab(null)
        }}
        onSave={persistSettings}
      />

      <footer
        className={`system-message-bar${status.isError ? ' is-error' : ''}${status.message ? ' has-message' : ''}`}
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        <div className="system-message-log-wrap" ref={statusLogPanelRef}>
          <button
            type="button"
            className={`system-message-log-btn${statusLogOpen ? ' active' : ''}`}
            title="System message log"
            aria-label="System message log"
            aria-expanded={statusLogOpen}
            aria-controls="system-message-log-panel"
            onClick={() => setStatusLogOpen((v) => !v)}
          >
            <svg
              className="system-message-log-icon"
              viewBox="0 0 16 16"
              width="14"
              height="14"
              aria-hidden="true"
            >
              <path
                fill="currentColor"
                d="M3 2.5A1.5 1.5 0 0 1 4.5 1h7A1.5 1.5 0 0 1 13 2.5v11A1.5 1.5 0 0 1 11.5 15h-7A1.5 1.5 0 0 1 3 13.5v-11Zm1.5-.5a.5.5 0 0 0-.5.5v11a.5.5 0 0 0 .5.5h7a.5.5 0 0 0 .5-.5v-11a.5.5 0 0 0-.5-.5h-7ZM5 4h6v1H5V4Zm0 2.5h6v1H5v-1Zm0 2.5h4v1H5V9Z"
              />
            </svg>
          </button>
          {statusLogOpen ? (
            <div
              id="system-message-log-panel"
              className="system-message-log-panel"
              role="dialog"
              aria-label="System message log"
            >
              <div className="system-message-log-header">
                <span>System message log</span>
                <button
                  type="button"
                  className="system-message-log-close"
                  onClick={() => setStatusLogOpen(false)}
                >
                  Close
                </button>
              </div>
              {statusLog.length === 0 ? (
                <p className="system-message-log-empty">No messages yet</p>
              ) : (
                <ul className="system-message-log-list" ref={statusLogListRef}>
                  {statusLog.map((entry) => (
                    <li
                      key={entry.id}
                      className={`system-message-log-item${entry.isError ? ' is-error' : ''}`}
                    >
                      <time
                        className="system-message-log-time"
                        dateTime={new Date(entry.at).toISOString()}
                      >
                        {formatStatusLogTime(entry.at)}
                      </time>
                      <span className="system-message-log-text">{entry.message}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}
        </div>
        <span
          className={`system-message-bar-text${status.isError ? ' is-error' : ''}${!status.message ? ' is-idle' : ''}`}
        >
          {status.message}
        </span>
      </footer>
    </div>
    </ComfyUiProvider>
  )
}
