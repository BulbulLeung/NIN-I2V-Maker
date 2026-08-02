import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent
} from 'react'
import type { AppSettings, ImageItem } from '../types'
import { LANGUAGES } from '../types'
import { generateI2vPromptForImage } from '../services/promptGen'
import { isTextEntryTarget, useArrowListNav } from '../hooks/useArrowListNav'
import { useBidirectionalTranslate } from '../hooks/useBidirectionalTranslate'
import {
  parseSidecarCaption,
  serializeSidecarCaption,
  sidecarHasContent
} from '../utils/sidecarCaption'
import { basenamePath, parentDir } from '../services/comfyI2v'
import { ConfirmDialog } from './ConfirmDialog'

function captionSidecarPath(imagePath: string): string {
  const dir = parentDir(imagePath)
  const name = basenamePath(imagePath)
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const sep = imagePath.includes('\\') ? '\\' : '/'
  return dir ? `${dir}${sep}${stem}.txt` : `${stem}.txt`
}

interface Props {
  settings: AppSettings
  /** False while another tab is shown (Prompt stays mounted). */
  active?: boolean
  /** True while a Generate panel is running video — Local AI is paused. */
  videoGenerating?: boolean
  onSettingsChange: (partial: Partial<AppSettings>) => void
  onStatus: (msg: string, isError?: boolean, options?: { sticky?: boolean }) => void
  onPromptSourceChange: (imagePath: string, promptText: string) => void
  onImagesChange: (images: ImageItem[]) => void
}

export function PromptView({
  settings,
  active = true,
  videoGenerating = false,
  onSettingsChange,
  onStatus,
  onPromptSourceChange,
  onImagesChange
}: Props) {
  const [images, setImages] = useState<ImageItem[]>([])
  const [selectedPath, setSelectedPath] = useState<string | null>(
    () => settings.promptImagePath.trim() || null
  )
  const imageListRef = useRef<HTMLUListElement | null>(null)
  const [english, setEnglish] = useState(() => settings.promptText)
  const [translated, setTranslated] = useState('')
  const [motionNote, setMotionNote] = useState('')
  const [dirty, setDirty] = useState(false)
  const [loadingList, setLoadingList] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const abortRef = useRef<AbortController | null>(null)
  const loadToken = useRef(0)
  const dragKind = useRef<'left' | 'right' | null>(null)
  const promptImagePathRef = useRef(settings.promptImagePath)
  promptImagePathRef.current = settings.promptImagePath
  const selectedPathRef = useRef(selectedPath)
  selectedPathRef.current = selectedPath
  const imagesRef = useRef(images)
  imagesRef.current = images

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
    enabled: Boolean(selectedPath) && !generating && !videoGenerating
  })

  useEffect(() => {
    if (videoGenerating) cancelInFlight()
  }, [videoGenerating, cancelInFlight])

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

  const imagePaths = useMemo(() => images.map((img) => img.path), [images])
  useArrowListNav({
    enabled: active && images.length > 0 && !confirmDelete,
    items: imagePaths,
    selectedId: selectedPath,
    onSelect: selectImage,
    columns: settings.listViewMode === 'thumbs' ? 'auto' : 1,
    containerRef: imageListRef,
    shouldIgnore: () =>
      Boolean(
        document.querySelector('.settings-modal, .toolbar-dataset-menu, .confirm-modal')
      )
  })

  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Delete') return
      if (e.defaultPrevented) return
      if (e.altKey || e.ctrlKey || e.metaKey) return
      if (isTextEntryTarget(e.target)) return
      if (document.querySelector('.settings-modal, .toolbar-dataset-menu, .confirm-modal')) {
        return
      }
      if (!selectedPathRef.current) return
      e.preventDefault()
      e.stopPropagation()
      setConfirmDelete(true)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [active])

  const performDeleteImage = useCallback(async () => {
    const path = selectedPathRef.current
    setConfirmDelete(false)
    if (!path) return
    const res = await window.api.trashItem(path)
    if (!res.ok) {
      onStatus(res.error || 'Failed to move image to Recycle Bin', true)
      return
    }
    const txt = captionSidecarPath(path)
    try {
      if (await window.api.pathExists(txt)) {
        await window.api.trashItem(txt)
      }
    } catch {
      /* image already trashed */
    }
    const list = imagesRef.current
    const idx = list.findIndex((img) => img.path === path)
    const nextList = list.filter((img) => img.path !== path)
    setImages(nextList)
    const nextPath = nextList[idx]?.path ?? nextList[idx - 1]?.path ?? null
    if (nextPath) {
      selectImage(nextPath)
    } else {
      setSelectedPath(null)
      onPromptSourceChange('', '')
      setEnglish('')
      setTranslated('')
      setMotionNote('')
      setDirty(false)
    }
    onStatus(`Moved to Recycle Bin: ${basenamePath(path)}`)
  }, [onStatus, onPromptSourceChange, selectImage])

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

  const runGenerate = async () => {
    if (!selectedPath) return
    if (videoGenerating) {
      onStatus('Local AI is paused while video is generating', true)
      return
    }
    // Drop any in-flight / debounced translation so prompt gen wins immediately.
    cancelInFlight()
    setTranslated('')
    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac
    setGenerating(true)
    onStatus(
      english.trim() ? 'Re-generating I2V prompt…' : 'Generating I2V prompt…',
      false,
      { sticky: true }
    )
    let generatedPrompt: string | null = null
    try {
      let imagePositive: string | undefined
      if (settings.useImagePrompt) {
        const meta = await window.api.readImagePositivePrompt(selectedPath)
        if (ac.signal.aborted) return
        if (meta.error) {
          onStatus(`Image prompt read failed: ${meta.error}`, true)
        } else if (meta.positive?.trim()) {
          imagePositive = meta.positive.trim()
          onStatus('Using embedded image prompt…', false, { sticky: true })
        } else {
          onStatus('No embedded image prompt in file metadata', false, { sticky: true })
        }
      }
      const prompt = await generateI2vPromptForImage(
        settings,
        selectedPath,
        ac.signal,
        motionNote,
        imagePositive
      )
      if (ac.signal.aborted) return
      generatedPrompt = prompt
      setEnglish(prompt)
      setEnglishSnapshot(prompt)
      setDirty(true)
      setTranslated('')
      onStatus(
        imagePositive
          ? 'Prompt generated (with image prompt)'
          : 'Prompt generated'
      )
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
    // After Generate finishes (and translation is re-enabled), translate the new prompt.
    if (generatedPrompt?.trim() && !ac.signal.aborted) {
      translateEnglishToTargetNow(generatedPrompt, selectedPath)
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
              aria-label="Thumbnail size"
            />
          </div>
        </div>

        <div className="sidebar-list">
          {loadingList ? (
            <div className="image-list empty">Loading images…</div>
          ) : images.length === 0 ? (
            <div className="image-list empty">
              {folder ? 'No images in this folder' : 'Add a folder from the toolbar to begin'}
            </div>
          ) : (
            <ul
              ref={imageListRef}
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
                        data-nav-id={img.path}
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
                      data-nav-id={img.path}
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
          <div className="caption-header prompt-preset-header">
            <label htmlFor="prompt-preset-select">Prompt preset</label>
            <div className="caption-header-actions">
              <select
                id="prompt-preset-select"
                className="prompt-preset-select"
                aria-label="Prompt preset"
                title="System / vision prompt preset used when generating"
                value={
                  settings.promptPresets.some((p) => p.id === settings.activePromptPresetId)
                    ? settings.activePromptPresetId
                    : (settings.promptPresets[0]?.id ?? '')
                }
                disabled={
                  generating || videoGenerating || settings.promptPresets.length === 0
                }
                onChange={(e) =>
                  onSettingsChange({ activePromptPresetId: e.target.value })
                }
              >
                {settings.promptPresets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name || 'Untitled preset'}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="caption-header">
            <label htmlFor="prompt-motion-note">Motion description (priority)</label>
          </div>
          <div className="caption-field caption-field-motion">
            <textarea
              id="prompt-motion-note"
              className="caption-textarea caption-textarea-motion"
              value={motionNote}
              onChange={(e) => onMotionNoteChange(e.target.value)}
              disabled={!selectedPath || generating || videoGenerating}
              spellCheck={false}
              placeholder="Describe the shot / action / pacing you want (Chinese or English OK). Generation also uses the image, and this note takes priority."
            />
          </div>

          <div className="caption-header">
            <label htmlFor="prompt-english">English prompt</label>
            <div className="caption-header-actions">
              <div
                className={`caption-image-prompt-toggle lora-toggle${settings.useImagePrompt ? ' is-on' : ''}${generating || videoGenerating ? ' is-disabled' : ''}`}
                title="On: include the image file's embedded positive prompt so the vision model can better judge characters, composition, expression, and action"
              >
                <span className="lora-toggle-label">Use image prompt</span>
                <button
                  type="button"
                  className="lora-switch"
                  role="switch"
                  aria-checked={settings.useImagePrompt}
                  aria-label="Use image prompt"
                  disabled={generating || videoGenerating}
                  onClick={() =>
                    onSettingsChange({ useImagePrompt: !settings.useImagePrompt })
                  }
                >
                  <span className="lora-switch-knob" />
                </button>
              </div>
              {generating ? (
                <button type="button" className="danger" onClick={cancelGenerate}>
                  Cancel
                </button>
              ) : (
                <button
                  type="button"
                  className="primary"
                  disabled={!selectedPath || videoGenerating}
                  title={
                    videoGenerating
                      ? 'Local AI is paused while video is generating'
                      : undefined
                  }
                  onClick={() => void runGenerate()}
                >
                  Generate Prompt
                </button>
              )}
            </div>
          </div>
          <div className="caption-field">
            <textarea
              id="prompt-english"
              className="caption-textarea"
              value={english}
              onChange={(e) => onEnglishChange(e.target.value)}
              disabled={!selectedPath || generating || videoGenerating}
              spellCheck={false}
              placeholder={
                videoGenerating
                  ? 'Local AI paused — video is generating'
                  : 'I2V motion prompt (English)'
              }
            />
            {generating ? (
              <div className="caption-field-overlay">
                <div className="caption-spinner" />
              </div>
            ) : null}
          </div>

          <div className="caption-header">
            <label htmlFor="prompt-translated">Translation</label>
            <div className="caption-header-actions">
              <select
                className="lang-select"
                id="prompt-target-language"
                aria-label="Target language"
                title="Target language"
                value={settings.targetLanguage}
                disabled={!selectedPath || generating || videoGenerating}
                onChange={(e) => onSettingsChange({ targetLanguage: e.target.value })}
              >
                {LANGUAGES.map((lang) => (
                  <option key={lang.code} value={lang.code}>
                    {lang.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="caption-field">
            <textarea
              id="prompt-translated"
              className="caption-textarea"
              value={translated}
              onChange={(e) => onTranslatedChange(e.target.value)}
              disabled={!selectedPath || generating || videoGenerating}
              spellCheck={false}
              placeholder={
                videoGenerating
                  ? 'Local AI paused — video is generating'
                  : `Translation (${langLabel})`
              }
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

      <ConfirmDialog
        open={confirmDelete}
        title="Delete image"
        message={
          selectedPath
            ? `Move this image to the Recycle Bin?\n${basenamePath(selectedPath)}`
            : 'Move this image to the Recycle Bin?'
        }
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => void performDeleteImage()}
      />
    </div>
  )
}
