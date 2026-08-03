import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppSettings, MergeDraft, SharedComfyDraft } from '../types'
import { basenamePath } from '../services/comfyI2v'
import { isTextEntryTarget, useArrowListNav } from '../hooks/useArrowListNav'
import { useBackdropDismiss } from '../hooks/useBackdropDismiss'
import { ConfirmDialog } from './ConfirmDialog'
import { GalleryVideoMetaBar } from './GalleryVideoMetaBar'
import { ResourceMonitorPane } from './ResourceMonitorPane'
import type { GalleryVideoMeta } from './SharedGenerateGalleryContext'

interface Props {
  active?: boolean
  settings: AppSettings
  sharedComfy: SharedComfyDraft
  draft: MergeDraft
  onDraftChange: (draft: MergeDraft) => void
  onStatus: (msg: string, isError?: boolean, options?: { sticky?: boolean }) => void
  videoGenerating?: boolean
  onVideoGeneratingChange?: (generating: boolean) => void
}

interface GalleryVideo {
  path: string
  name: string
  mtimeMs: number
}

function isMergeVideoName(name: string): boolean {
  return /_merge/i.test(name) || /^MERGE_/i.test(name)
}

function formatElapsed(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000))
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}m ${s}s`
}

function ensureSlots(paths: string[]): string[] {
  return paths.length > 0 ? paths : ['']
}

export function MergeView({
  active = true,
  settings: _settings,
  sharedComfy,
  draft,
  onDraftChange,
  onStatus,
  videoGenerating = false,
  onVideoGeneratingChange
}: Props) {
  const draftRef = useRef(draft)
  draftRef.current = draft

  const [videos, setVideos] = useState<GalleryVideo[]>([])
  const [resultVideoPath, setResultVideoPath] = useState<string | null>(null)
  const [resultVideoMeta, setResultVideoMeta] = useState<GalleryVideoMeta | null>(null)
  const [merging, setMerging] = useState(false)
  const [mergeElapsedSec, setMergeElapsedSec] = useState(0)
  const [videoPickerOpen, setVideoPickerOpen] = useState(false)
  const [pickerSlotIndex, setPickerSlotIndex] = useState(0)
  const [confirmDeleteVideo, setConfirmDeleteVideo] = useState(false)
  const videoPickerListRef = useRef<HTMLDivElement | null>(null)
  const resultGalleryRef = useRef<HTMLDivElement | null>(null)
  const mergeVideosRef = useRef<GalleryVideo[]>([])
  const mergingRef = useRef(false)

  const dismissVideoPicker = useCallback(() => setVideoPickerOpen(false), [])
  const videoPickerBackdrop = useBackdropDismiss(dismissVideoPicker)

  const patchDraft = useCallback(
    (partial: Partial<MergeDraft>) => {
      onDraftChange({ ...draftRef.current, ...partial })
    },
    [onDraftChange]
  )

  const setVideoPaths = useCallback(
    (next: string[] | ((prev: string[]) => string[])) => {
      const prev = ensureSlots(draftRef.current.videoPaths)
      const paths = typeof next === 'function' ? next(prev) : next
      patchDraft({ videoPaths: ensureSlots(paths) })
    },
    [patchDraft]
  )

  const refreshGallery = useCallback(async () => {
    const folder = sharedComfy.outputFolder.trim()
    if (!folder) {
      setVideos([])
      return
    }
    try {
      const res = await window.api.galleryListVideos({ outputFolder: folder })
      if (!res.ok) {
        setVideos([])
        return
      }
      setVideos(res.videos)
      const mergeList = res.videos.filter((v) => isMergeVideoName(v.name))
      setResultVideoPath((prev) => {
        if (prev && mergeList.some((v) => v.path === prev)) return prev
        return mergeList[0]?.path ?? null
      })
    } catch {
      setVideos([])
    }
  }, [sharedComfy.outputFolder])

  const mergeVideos = useMemo(
    () => videos.filter((v) => isMergeVideoName(v.name)),
    [videos]
  )
  mergeVideosRef.current = mergeVideos

  const sourceVideos = useMemo(
    () => videos.filter((v) => !isMergeVideoName(v.name)),
    [videos]
  )

  useEffect(() => {
    if (!active) return
    void refreshGallery()
  }, [active, sharedComfy.outputFolder, refreshGallery])

  useEffect(() => {
    if (!resultVideoPath) {
      setResultVideoMeta(null)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const res = await window.api.galleryProbeVideo({ path: resultVideoPath })
        if (cancelled) return
        if (res.ok && res.info) {
          setResultVideoMeta({
            name: res.info.name,
            sizeBytes: res.info.sizeBytes,
            width: res.info.width,
            height: res.info.height,
            codec: res.info.codec,
            bitDepth: res.info.bitDepth,
            container: res.info.container,
            seed: res.info.seed ?? null,
            prompt: res.info.prompt ?? null
          })
        } else {
          setResultVideoMeta({
            name: basenamePath(resultVideoPath),
            sizeBytes: 0,
            width: null,
            height: null,
            codec: null,
            bitDepth: null,
            container: null,
            seed: null,
            prompt: null
          })
        }
      } catch {
        if (!cancelled) setResultVideoMeta(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [resultVideoPath])

  const clipPaths = ensureSlots(draft.videoPaths)
  const filledPaths = clipPaths.map((p) => p.trim()).filter(Boolean)
  const sourceVideoPaths = useMemo(() => sourceVideos.map((v) => v.path), [sourceVideos])
  const mergeResultPaths = useMemo(() => mergeVideos.map((v) => v.path), [mergeVideos])
  const pickerSelectedPath = clipPaths[pickerSlotIndex]?.trim() || null

  useArrowListNav({
    enabled: active && videoPickerOpen && sourceVideoPaths.length > 0,
    items: sourceVideoPaths,
    selectedId: pickerSelectedPath,
    onSelect: (id) => {
      setVideoPaths((prev) => {
        const next = [...ensureSlots(prev)]
        const idx = Math.min(Math.max(0, pickerSlotIndex), next.length - 1)
        next[idx] = id
        return next
      })
      setVideoPickerOpen(false)
    },
    columns: 'auto',
    containerRef: videoPickerListRef,
    shouldIgnore: () =>
      Boolean(
        document.querySelector(
          '.settings-modal, .confirm-modal, .setup-incomplete-modal, .generate-image-picker-modal'
        )
      )
  })

  useArrowListNav({
    enabled:
      active &&
      !videoPickerOpen &&
      !merging &&
      mergeResultPaths.length > 0 &&
      !isTextEntryTarget(document.activeElement),
    items: mergeResultPaths,
    selectedId: resultVideoPath,
    onSelect: (id) => setResultVideoPath(id),
    columns: 'auto',
    containerRef: resultGalleryRef,
    shouldIgnore: () =>
      Boolean(
        document.querySelector(
          '.settings-modal, .confirm-modal, .setup-incomplete-modal, .generate-image-picker-modal'
        )
      )
  })

  useEffect(() => {
    if (!active || !videoPickerOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setVideoPickerOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, videoPickerOpen])

  const openSlotPicker = useCallback((index: number) => {
    setPickerSlotIndex(index)
    setVideoPickerOpen(true)
  }, [])

  const addVideoSlot = useCallback(() => {
    setVideoPaths((prev) => [...ensureSlots(prev), ''])
  }, [setVideoPaths])

  const moveClip = useCallback(
    (index: number, dir: -1 | 1) => {
      setVideoPaths((prev) => {
        const next = [...ensureSlots(prev)]
        const j = index + dir
        if (j < 0 || j >= next.length) return prev
        ;[next[index], next[j]] = [next[j], next[index]]
        return next
      })
    },
    [setVideoPaths]
  )

  const removeClip = useCallback(
    (index: number) => {
      setVideoPaths((prev) => {
        const next = ensureSlots(prev).filter((_, i) => i !== index)
        return next.length > 0 ? next : ['']
      })
    },
    [setVideoPaths]
  )

  const abortMerge = useCallback(async () => {
    await window.api.galleryCancelConcatVideos()
    onStatus('Merge cancelled')
  }, [onStatus])

  const runMerge = useCallback(async () => {
    if (mergingRef.current) return
    const paths = draftRef.current.videoPaths.map((p) => p.trim()).filter(Boolean)
    const folder = sharedComfy.outputFolder.trim()
    if (paths.length < 2) {
      onStatus('Add at least 2 videos to merge', true)
      return
    }
    if (!folder) {
      onStatus('Set Output folder in Settings → ComfyUI', true)
      return
    }

    mergingRef.current = true
    setMerging(true)
    setMergeElapsedSec(0)
    onVideoGeneratingChange?.(true)
    const startedAt = Date.now()
    const timer = window.setInterval(() => {
      setMergeElapsedSec(Math.floor((Date.now() - startedAt) / 1000))
    }, 1000)

    try {
      onStatus(`Merging ${paths.length} videos…`)
      const res = await window.api.galleryConcatVideos({
        paths,
        outputFolder: folder,
        namePrefix: 'MERGE'
      })
      if (!res.ok || !res.path) {
        throw new Error(res.error || 'Merge failed')
      }
      await refreshGallery()
      setResultVideoPath(res.path)
      const elapsed = formatElapsed(Date.now() - startedAt)
      const modeHint = res.mode === 'reencode' ? ' (re-encoded)' : ''
      onStatus(`Done — Merge${modeHint}, ${elapsed}`, false, { sticky: true })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (/cancel/i.test(msg)) {
        onStatus('Merge cancelled')
        return
      }
      onStatus(msg, true)
    } finally {
      window.clearInterval(timer)
      mergingRef.current = false
      setMerging(false)
      setMergeElapsedSec(0)
      onVideoGeneratingChange?.(false)
    }
  }, [onStatus, onVideoGeneratingChange, refreshGallery, sharedComfy.outputFolder])

  const confirmDeleteResult = useCallback(async () => {
    const path = resultVideoPath
    setConfirmDeleteVideo(false)
    if (!path) return
    const res = await window.api.trashItem(path)
    if (!res.ok) {
      onStatus(res.error || 'Failed to delete', true)
      return
    }
    setResultVideoPath(null)
    await refreshGallery()
    onStatus('Moved to Recycle Bin')
  }, [onStatus, refreshGallery, resultVideoPath])

  useEffect(() => {
    if (!active || merging || videoPickerOpen || confirmDeleteVideo) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      if (isTextEntryTarget(document.activeElement)) return
      if (
        document.querySelector(
          '.settings-modal, .confirm-modal, .setup-incomplete-modal, .generate-image-picker-modal'
        )
      ) {
        return
      }
      if (!resultVideoPath) return
      e.preventDefault()
      setConfirmDeleteVideo(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, confirmDeleteVideo, merging, resultVideoPath, videoPickerOpen])

  const canMerge = filledPaths.length >= 2 && !merging && !videoGenerating

  return (
    <div className="generate-view upscale-view merge-view">
      <div className="generate-body">
        <aside className="generate-settings">
          <div className="generate-settings-scroll upscale-settings-scroll">
            <div className="generate-settings-col">
              <div className="field">
                <div className="merge-clip-header">
                  <span>Videos to merge ({filledPaths.length})</span>
                  <button
                    type="button"
                    className="merge-add-video-btn"
                    disabled={merging}
                    onClick={addVideoSlot}
                  >
                    Add video
                  </button>
                </div>
                {!sharedComfy.outputFolder.trim() ? (
                  <p className="field-hint">Set Output folder in Settings → ComfyUI.</p>
                ) : (
                  <p className="field-hint">Order = merge order. Need 2+ videos.</p>
                )}
                <ul className="merge-clip-list">
                  {clipPaths.map((path, index) => {
                    const trimmed = path.trim()
                    const known = videos.find((v) => v.path === trimmed)
                    const selected = known ||
                      (trimmed
                        ? { path: trimmed, name: basenamePath(trimmed), mtimeMs: 0 }
                        : null)
                    return (
                      <li key={`slot-${index}`} className="merge-clip-item">
                        {!sharedComfy.outputFolder.trim() ? (
                          <p className="field-hint">Set Output folder first.</p>
                        ) : sourceVideos.length === 0 && !selected ? (
                          <p className="field-hint">No videos in output folder yet.</p>
                        ) : !selected ? (
                          <button
                            type="button"
                            className="generate-selected-image-btn is-empty merge-slot-btn"
                            disabled={merging}
                            onClick={() => openSlotPicker(index)}
                          >
                            Click to choose video
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="generate-selected-image-btn upscale-selected-video-btn merge-slot-btn"
                            title={selected.name}
                            disabled={merging}
                            onClick={() => openSlotPicker(index)}
                          >
                            <video
                              key={selected.path}
                              src={window.api.toLocalUrl(selected.path)}
                              muted
                              loop
                              playsInline
                              autoPlay
                              preload="auto"
                              onLoadedData={(e) => {
                                void e.currentTarget.play().catch(() => undefined)
                              }}
                            />
                          </button>
                        )}
                        <div className="merge-clip-meta">
                          <div className="merge-clip-row-actions">
                            <button
                              type="button"
                              disabled={merging || index === 0}
                              onClick={() => moveClip(index, -1)}
                              title="Move up"
                            >
                              ↑
                            </button>
                            <button
                              type="button"
                              disabled={merging || index >= clipPaths.length - 1}
                              onClick={() => moveClip(index, 1)}
                              title="Move down"
                            >
                              ↓
                            </button>
                            <button
                              type="button"
                              disabled={merging || clipPaths.length <= 1}
                              onClick={() => removeClip(index)}
                              title="Remove slot"
                            >
                              ×
                            </button>
                          </div>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              </div>
            </div>
          </div>

          <div className="generate-actions">
            {merging ? (
              <button
                type="button"
                className="danger lora-test-generate-btn"
                onClick={() => void abortMerge()}
              >
                Abort · {mergeElapsedSec} Sec
              </button>
            ) : (
              <button
                type="button"
                className="primary lora-test-generate-btn"
                disabled={!canMerge}
                title={
                  videoGenerating
                    ? 'Another panel is busy'
                    : filledPaths.length < 2
                      ? 'Need at least 2 videos'
                      : undefined
                }
                onClick={() => void runMerge()}
              >
                Merge
              </button>
            )}
          </div>
        </aside>

        <section className="generate-gallery upscale-result-pane">
          <div className="generate-gallery-header">
            <span>
              {mergeVideos.length} merge video{mergeVideos.length === 1 ? '' : 's'}
              {sharedComfy.outputFolder ? ` · ${sharedComfy.outputFolder}` : ''}
            </span>
            <div className="generate-gallery-header-actions">
              <button type="button" onClick={() => void refreshGallery()}>
                Refresh
              </button>
              <button
                type="button"
                disabled={!sharedComfy.outputFolder.trim()}
                onClick={() => {
                  void window.api.openPathInExplorer(sharedComfy.outputFolder.trim())
                }}
              >
                Open folder
              </button>
            </div>
          </div>

          <div className="generate-video-player upscale-result-player">
            {resultVideoPath ? (
              <video
                key={resultVideoPath}
                src={window.api.toLocalUrl(resultVideoPath)}
                controls
                loop
                playsInline
                autoPlay
                onLoadedData={(e) => {
                  void e.currentTarget.play().catch(() => undefined)
                }}
              />
            ) : (
              <div className="generate-video-player-empty">No merge result yet</div>
            )}
            {resultVideoPath && resultVideoMeta ? (
              <GalleryVideoMetaBar meta={resultVideoMeta} onStatus={onStatus} />
            ) : null}
          </div>

          <div className="i2v-gallery" ref={resultGalleryRef}>
            {mergeVideos.length === 0 ? (
              <div className="i2v-gallery-empty">No merge videos</div>
            ) : (
              mergeVideos.map((v) => (
                <button
                  key={v.path}
                  type="button"
                  data-nav-id={v.path}
                  className={`i2v-gallery-item${v.path === resultVideoPath ? ' active' : ''}`}
                  onClick={() => setResultVideoPath(v.path)}
                  title={v.name}
                >
                  <video
                    src={window.api.toLocalUrl(v.path)}
                    muted
                    loop
                    playsInline
                    preload="metadata"
                    onMouseEnter={(e) => {
                      void e.currentTarget.play().catch(() => undefined)
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.pause()
                      e.currentTarget.currentTime = 0
                    }}
                  />
                </button>
              ))
            )}
          </div>
        </section>

        <aside className="generate-monitor">
          <ResourceMonitorPane device="cuda:0" active={active} />
        </aside>
      </div>

      {videoPickerOpen ? (
        <div
          className="modal-backdrop"
          role="presentation"
          {...videoPickerBackdrop}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setVideoPickerOpen(false)
          }}
        >
          <div
            className="modal modal-wide generate-image-picker-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Choose video"
          >
            <div className="generate-image-picker-header">
              <h2>Choose video</h2>
              <button type="button" onClick={() => setVideoPickerOpen(false)}>
                Close
              </button>
            </div>
            <div
              ref={videoPickerListRef}
              className="generate-prompt-image-list generate-image-picker-grid"
              role="listbox"
            >
              {sourceVideos.map((v) => {
                const isActive = v.path === pickerSelectedPath
                return (
                  <button
                    key={v.path}
                    type="button"
                    role="option"
                    data-nav-id={v.path}
                    aria-selected={isActive}
                    className={`generate-prompt-image-item upscale-picker-video-item${isActive ? ' active' : ''}`}
                    title={v.name}
                    onClick={() => {
                      setVideoPaths((prev) => {
                        const next = [...ensureSlots(prev)]
                        const idx = Math.min(Math.max(0, pickerSlotIndex), next.length - 1)
                        next[idx] = v.path
                        return next
                      })
                      setVideoPickerOpen(false)
                    }}
                    onMouseEnter={(e) => {
                      const video = e.currentTarget.querySelector('video')
                      if (video) void video.play().catch(() => undefined)
                    }}
                    onMouseLeave={(e) => {
                      const video = e.currentTarget.querySelector('video')
                      if (!video) return
                      video.pause()
                      video.currentTime = 0
                    }}
                  >
                    <video
                      src={window.api.toLocalUrl(v.path)}
                      muted
                      loop
                      playsInline
                      preload="metadata"
                    />
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmDeleteVideo}
        title="Delete video"
        message={
          resultVideoPath
            ? `Move this video to the Recycle Bin?\n${basenamePath(resultVideoPath)}`
            : 'Move this video to the Recycle Bin?'
        }
        onCancel={() => setConfirmDeleteVideo(false)}
        onConfirm={() => void confirmDeleteResult()}
      />
    </div>
  )
}
