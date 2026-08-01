import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent
} from 'react'
import type { AppSettings, ImageItem } from '../types'
import { LANGUAGES } from '../types'
import { generateI2vPromptForImage } from '../services/promptGen'
import { useBidirectionalTranslate } from '../hooks/useBidirectionalTranslate'
import {
  parseSidecarCaption,
  serializeSidecarCaption,
  sidecarHasContent
} from '../utils/sidecarCaption'

interface Props {
  settings: AppSettings
  onSettingsChange: (partial: Partial<AppSettings>) => void
  onStatus: (msg: string, isError?: boolean, options?: { sticky?: boolean }) => void
  onPromptSourceChange: (imagePath: string, promptText: string) => void
  onImagesChange: (images: ImageItem[]) => void
}

function folderLabel(path: string): string {
  const norm = path.replace(/\\/g, '/')
  const i = norm.lastIndexOf('/')
  return i >= 0 ? path.slice(i + 1) : path
}

export function PromptView({
  settings,
  onSettingsChange,
  onStatus,
  onPromptSourceChange,
  onImagesChange
}: Props) {
  const [images, setImages] = useState<ImageItem[]>([])
  const [selectedPath, setSelectedPath] = useState<string | null>(
    () => settings.promptImagePath.trim() || null
  )
  const [english, setEnglish] = useState(() => settings.promptText)
  const [translated, setTranslated] = useState('')
  const [motionNote, setMotionNote] = useState('')
  const [dirty, setDirty] = useState(false)
  const [loadingList, setLoadingList] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [folderMenuOpen, setFolderMenuOpen] = useState(false)

  const abortRef = useRef<AbortController | null>(null)
  const loadToken = useRef(0)
  const dragKind = useRef<'left' | 'right' | null>(null)
  const folderMenuRef = useRef<HTMLDivElement | null>(null)
  const promptImagePathRef = useRef(settings.promptImagePath)
  promptImagePathRef.current = settings.promptImagePath

  const folder = settings.lastFolder
  const langLabel =
    LANGUAGES.find((l) => l.code === settings.targetLanguage)?.label ?? settings.targetLanguage

  const {
    translating,
    translatingPath,
    error: translateError,
    cancelInFlight,
    scheduleEnglishToTarget,
    scheduleTargetToEnglish,
    translateEnglishToTargetNow,
    setEnglishSnapshot
  } = useBidirectionalTranslate({
    settings,
    selectedPath,
    setEnglish,
    setTranslated,
    enabled: Boolean(selectedPath) && !generating
  })

  const loadImages = useCallback(
    async (dir: string | null) => {
      if (!dir) {
        setImages([])
        setSelectedPath(null)
        setEnglish('')
        setTranslated('')
        setMotionNote('')
        setDirty(false)
        return
      }
      setLoadingList(true)
      try {
        const list = await window.api.listImages(dir)
        setImages(list)
        // Prefer App selection over a stale local prev (avoids path ping-pong).
        setSelectedPath((prev) => {
          const saved = promptImagePathRef.current.trim()
          if (saved && list.some((img) => img.path === saved)) return saved
          if (prev && list.some((img) => img.path === prev)) return prev
          const first = list[0]?.path ?? null
          // Seed App selection once when nothing stored yet.
          if (first && !saved) {
            queueMicrotask(() => onPromptSourceChange(first, ''))
          }
          return first
        })
      } catch (err) {
        onStatus(err instanceof Error ? err.message : String(err), true)
        setImages([])
        setSelectedPath(null)
      } finally {
        setLoadingList(false)
      }
    },
    [onStatus, onPromptSourceChange]
  )

  useEffect(() => {
    void loadImages(folder)
  }, [folder, loadImages])

  useEffect(() => {
    onImagesChange(images)
  }, [images, onImagesChange])

  // Adopt Generate-panel picks. Depend only on App path (not selectedPath) to avoid loops.
  useEffect(() => {
    const external = settings.promptImagePath.trim()
    if (!external) return
    setSelectedPath((prev) => (prev === external ? prev : external))
  }, [settings.promptImagePath])

  // Only sync english when local path already matches App (path ownership = click handlers).
  useEffect(() => {
    const imagePath = selectedPath ?? ''
    if (!imagePath) return
    if (imagePath !== settings.promptImagePath) return
    if (english === settings.promptText) return
    onPromptSourceChange(imagePath, english)
  }, [selectedPath, english, onPromptSourceChange, settings.promptImagePath, settings.promptText])

  const selectImage = useCallback(
    (imagePath: string) => {
      setSelectedPath(imagePath)
      // Establish path in App immediately so Generate list & sync stay aligned.
      onPromptSourceChange(imagePath, imagePath === settings.promptImagePath ? english : '')
    },
    [onPromptSourceChange, settings.promptImagePath, english]
  )

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (!folderMenuRef.current?.contains(e.target as Node)) {
        setFolderMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [])

  const loadCaption = useCallback(
    async (imagePath: string) => {
      const token = ++loadToken.current
      cancelInFlight()
      setDirty(false)
      try {
        const text = await window.api.readCaption(imagePath)
        if (token !== loadToken.current) return
        const parsed = parseSidecarCaption(text)
        setMotionNote(parsed.motionNote)
        setEnglish(parsed.prompt)
        setEnglishSnapshot(parsed.prompt)
        setTranslated('')
        if (parsed.prompt.trim()) {
          translateEnglishToTargetNow(parsed.prompt, imagePath)
        }
      } catch (err) {
        if (token !== loadToken.current) return
        onStatus(err instanceof Error ? err.message : String(err), true)
        setMotionNote('')
        setEnglish('')
        setTranslated('')
      }
    },
    [cancelInFlight, onStatus, setEnglishSnapshot, translateEnglishToTargetNow]
  )

  useEffect(() => {
    if (!selectedPath) {
      setEnglish('')
      setTranslated('')
      setMotionNote('')
      setDirty(false)
      return
    }
    void loadCaption(selectedPath)
  }, [selectedPath, loadCaption])

  useEffect(() => {
    if (translateError) onStatus(translateError, true)
  }, [translateError, onStatus])

  const addFolder = async () => {
    const dir = await window.api.openFolder()
    if (!dir) return
    const folders = settings.imageFolders.includes(dir)
      ? settings.imageFolders
      : [...settings.imageFolders, dir]
    onSettingsChange({
      imageFolders: folders,
      lastFolder: dir
    })
    setFolderMenuOpen(false)
    onStatus(`Opened folder: ${folderLabel(dir)}`)
  }

  const selectFolder = (dir: string) => {
    onSettingsChange({ lastFolder: dir })
    setFolderMenuOpen(false)
  }

  const saveCaption = async () => {
    if (!selectedPath) return
    try {
      const body = serializeSidecarCaption(motionNote, english)
      await window.api.writeCaption(selectedPath, body)
      setDirty(false)
      setImages((prev) =>
        prev.map((img) =>
          img.path === selectedPath
            ? { ...img, hasCaption: sidecarHasContent(motionNote, english) }
            : img
        )
      )
      onStatus('Prompt saved')
    } catch (err) {
      onStatus(err instanceof Error ? err.message : String(err), true)
    }
  }

  const runGenerate = async (force: boolean) => {
    if (!selectedPath) return
    if (!force && english.trim()) {
      onStatus('Prompt already exists — use Re-generate to overwrite', false)
      return
    }
    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac
    setGenerating(true)
    onStatus('Generating I2V prompt…', false, { sticky: true })
    try {
      const prompt = await generateI2vPromptForImage(
        settings,
        selectedPath,
        ac.signal,
        motionNote
      )
      if (ac.signal.aborted) return
      setEnglish(prompt)
      setEnglishSnapshot(prompt)
      setDirty(true)
      setTranslated('')
      if (prompt.trim()) translateEnglishToTargetNow(prompt, selectedPath)
      onStatus('Prompt generated')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg === 'Prompt generation cancelled') {
        onStatus('Generation cancelled')
        return
      }
      onStatus(msg, true)
    } finally {
      if (abortRef.current === ac) abortRef.current = null
      setGenerating(false)
    }
  }

  const cancelGenerate = () => {
    abortRef.current?.abort()
    abortRef.current = null
    setGenerating(false)
    onStatus('Cancelling…')
  }

  const onMotionNoteChange = (value: string) => {
    setMotionNote(value)
    setDirty(true)
  }

  const onEnglishChange = (value: string) => {
    setEnglish(value)
    setDirty(true)
    setEnglishSnapshot(value)
    scheduleEnglishToTarget(value)
  }

  const onTranslatedChange = (value: string) => {
    setTranslated(value)
    setDirty(true)
    scheduleTargetToEnglish(value)
  }

  const startResize = (kind: 'left' | 'right') => (e: ReactMouseEvent) => {
    e.preventDefault()
    dragKind.current = kind
    const startX = e.clientX
    const startLeft = settings.sidebarWidth
    const startRight = settings.rightPaneWidth

    const onMove = (ev: MouseEvent) => {
      if (dragKind.current === 'left') {
        const next = Math.min(480, Math.max(160, startLeft + (ev.clientX - startX)))
        onSettingsChange({ sidebarWidth: next })
      } else if (dragKind.current === 'right') {
        const next = Math.min(640, Math.max(240, startRight - (ev.clientX - startX)))
        onSettingsChange({ rightPaneWidth: next })
      }
    }
    const onUp = () => {
      dragKind.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const selected = images.find((img) => img.path === selectedPath) ?? null
  const previewUrl = selectedPath ? window.api.toLocalUrl(selectedPath) : null
  const showTranslateOverlay =
    translating && translatingPath === selectedPath && !generating

  return (
    <div
      className="prompt-view main"
      style={
        {
          '--sidebar-width': `${settings.sidebarWidth}px`,
          '--right-pane-width': `${settings.rightPaneWidth}px`
        } as CSSProperties
      }
    >
      <aside className="sidebar">
        <div className="list-toolbar">
          <div className="list-toolbar-left" ref={folderMenuRef}>
            <div className="toolbar-dataset">
              <button
                type="button"
                className="toolbar-dataset-trigger"
                onClick={() => setFolderMenuOpen((v) => !v)}
                title={folder ?? 'No folder'}
              >
                <span className="toolbar-dataset-label">
                  {folder ? folderLabel(folder) : 'Select folder'}
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
                          className={`toolbar-dataset-option${dir === folder ? ' active' : ''}`}
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
            <button type="button" onClick={() => void addFolder()}>
              Add folder
            </button>
          </div>
          <div className="list-toolbar-right">
            <button
              type="button"
              className={`list-toolbar-btn${settings.listViewMode === 'list' ? ' active' : ''}`}
              title="List view"
              onClick={() => onSettingsChange({ listViewMode: 'list' })}
            >
              ≡
            </button>
            <button
              type="button"
              className={`list-toolbar-btn${settings.listViewMode === 'thumbs' ? ' active' : ''}`}
              title="Thumbnails"
              onClick={() => onSettingsChange({ listViewMode: 'thumbs' })}
            >
              ▦
            </button>
            {settings.listViewMode === 'thumbs' ? (
              <input
                type="range"
                className="list-toolbar-slider"
                min={64}
                max={200}
                value={settings.thumbnailWidth}
                onChange={(e) =>
                  onSettingsChange({ thumbnailWidth: Number(e.target.value) })
                }
                title="Thumbnail size"
              />
            ) : null}
          </div>
        </div>

        <div className="sidebar-list">
          {loadingList ? (
            <div className="image-list empty">Loading images…</div>
          ) : images.length === 0 ? (
            <div className="image-list empty">
              {folder ? 'No images in this folder' : 'Add a folder to begin'}
            </div>
          ) : (
            <ul
              className={`image-list${settings.listViewMode === 'thumbs' ? ' thumbnails' : ''}`}
              style={
                settings.listViewMode === 'thumbs'
                  ? ({ '--thumb-w': `${settings.thumbnailWidth}px` } as CSSProperties)
                  : undefined
              }
            >
              {images.map((img) => {
                const selectedCls = img.path === selectedPath ? ' selected' : ''
                const busyCls =
                  generating && img.path === selectedPath ? ' is-busy' : ''
                if (settings.listViewMode === 'thumbs') {
                  return (
                    <li key={img.path} className="image-list-grid-item">
                      <button
                        type="button"
                        className={`image-list-item thumb${selectedCls}${busyCls}`}
                        onClick={() => selectImage(img.path)}
                        title={img.name}
                      >
                        <div className="image-list-thumb">
                          <img src={window.api.toLocalUrl(img.path)} alt="" loading="lazy" />
                        </div>
                        <div className="image-list-meta">
                          <span className="image-list-name">{img.name}</span>
                          {img.hasCaption ? <span className="badge">txt</span> : null}
                        </div>
                      </button>
                    </li>
                  )
                }
                return (
                  <li key={img.path}>
                    <button
                      type="button"
                      className={`image-list-item${selectedCls}${busyCls}`}
                      onClick={() => selectImage(img.path)}
                      title={img.name}
                    >
                      <div className="image-list-meta">
                        <span className="image-list-name">{img.name}</span>
                      </div>
                      {img.hasCaption ? <span className="badge">txt</span> : null}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </aside>

      <button
        type="button"
        className="pane-resizer"
        aria-label="Resize sidebar"
        onMouseDown={startResize('left')}
      />

      <section className="center-pane">
        <div className="preview-toolbar">
          <div className="preview-toolbar-left">
            {selected ? selected.name : 'No image selected'}
            {dirty ? <span className="dirty-flag"> • unsaved</span> : null}
          </div>
          <div className="preview-toolbar-right">
            <span className="image-count">
              {images.length} image{images.length === 1 ? '' : 's'}
            </span>
          </div>
        </div>
        <div className="prompt-preview-stage">
          {previewUrl ? (
            <img className="prompt-preview-img" src={previewUrl} alt={selected?.name ?? ''} />
          ) : (
            <div className="prompt-preview-empty">Select an image to preview</div>
          )}
        </div>
      </section>

      <button
        type="button"
        className="pane-resizer"
        aria-label="Resize prompt pane"
        onMouseDown={startResize('right')}
      />

      <aside className="right-pane prompt-right-pane">
        <div className="caption-panel">
          <div className="caption-header">
            <label htmlFor="prompt-motion-note">動態說明（優先）</label>
          </div>
          <div className="caption-field caption-field-motion">
            <textarea
              id="prompt-motion-note"
              className="caption-textarea caption-textarea-motion"
              value={motionNote}
              onChange={(e) => onMotionNoteChange(e.target.value)}
              disabled={!selectedPath || generating}
              spellCheck={false}
              placeholder="描述想要的鏡頭／動作／節奏（可中英）。生成時會同時參考圖片，並以這段說明為優先。"
            />
          </div>

          <div className="caption-header">
            <label htmlFor="prompt-english">English prompt</label>
            <div className="caption-header-actions">
              {generating ? (
                <button type="button" className="danger" onClick={cancelGenerate}>
                  Cancel
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className="primary"
                    disabled={!selectedPath}
                    onClick={() => void runGenerate(false)}
                  >
                    Generate Prompt
                  </button>
                  <button
                    type="button"
                    disabled={!selectedPath}
                    onClick={() => void runGenerate(true)}
                  >
                    Re-generate
                  </button>
                </>
              )}
            </div>
          </div>
          <div className="caption-field">
            <textarea
              id="prompt-english"
              className="caption-textarea"
              value={english}
              onChange={(e) => onEnglishChange(e.target.value)}
              disabled={!selectedPath || generating}
              spellCheck={false}
              placeholder="I2V motion prompt (English)"
            />
            {generating ? (
              <div className="caption-field-overlay">
                <div className="caption-spinner" />
              </div>
            ) : null}
          </div>

          <div className="caption-header">
            <label htmlFor="prompt-translated">{langLabel}</label>
          </div>
          <div className="caption-field">
            <textarea
              id="prompt-translated"
              className="caption-textarea"
              value={translated}
              onChange={(e) => onTranslatedChange(e.target.value)}
              disabled={!selectedPath || generating}
              spellCheck={false}
              placeholder={`Translation (${langLabel})`}
            />
            {showTranslateOverlay ? (
              <div className="caption-field-overlay">
                <div className="caption-spinner" />
              </div>
            ) : null}
          </div>

          <div className="prompt-actions">
            <button
              type="button"
              className="primary"
              disabled={!selectedPath || !dirty}
              onClick={() => void saveCaption()}
            >
              Save
            </button>
            <p className="field-hint prompt-sync-hint">
              I2V / FLF2V / LOOP use the selected image and English prompt automatically.
            </p>
          </div>
        </div>
      </aside>
    </div>
  )
}
