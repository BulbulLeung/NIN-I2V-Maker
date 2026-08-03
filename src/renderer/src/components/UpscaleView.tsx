import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppSettings, SharedComfyDraft, UpscaleGenerateDraft } from '../types'
import { basenamePath } from '../services/comfyI2v'
import {
  COMFY_BASE_URL,
  generateUpscaleWithComfy,
  interruptComfyGeneration
} from '../services/comfyUpscale'
import { unloadLocalAiModels } from '../services/unloadLocalAi'
import { isTextEntryTarget, useArrowListNav } from '../hooks/useArrowListNav'
import { useBackdropDismiss } from '../hooks/useBackdropDismiss'
import { ConfirmDialog } from './ConfirmDialog'
import { GalleryVideoMetaBar } from './GalleryVideoMetaBar'
import { ResourceMonitorPane } from './ResourceMonitorPane'
import { SearchableSelect } from './SearchableSelect'
import { uniqueDirs, useComfyUi } from './ComfyUiContext'
import type { GalleryVideoMeta } from './SharedGenerateGalleryContext'
import {
  forgetCompareSource,
  isUpscaleResultName,
  loadCompareSourceMap,
  lookupCompareSource,
  rememberCompareSource,
  resolveCompareSourcePath
} from '../utils/galleryCompareSource'
import {
  DEFAULT_RESOLUTION_PRESET,
  isResolutionPreset,
  RESOLUTION_PRESET_OPTIONS,
  resolveWanResolution
} from '../utils/wanResolution'

interface Props {
  active?: boolean
  settings: AppSettings
  sharedComfy: SharedComfyDraft
  draft: UpscaleGenerateDraft
  onSharedComfyChange: (shared: SharedComfyDraft) => void
  onDraftChange: (draft: UpscaleGenerateDraft) => void
  onStatus: (msg: string, isError?: boolean, options?: { sticky?: boolean }) => void
  videoGenerating?: boolean
  onVideoGeneratingChange?: (generating: boolean) => void
}

interface GalleryVideo {
  path: string
  name: string
  mtimeMs: number
}

function isUpscaleVideoName(name: string): boolean {
  return isUpscaleResultName(name)
}

export function UpscaleView({
  active = true,
  settings,
  sharedComfy,
  draft,
  onSharedComfyChange: _onSharedComfyChange,
  onDraftChange,
  onStatus,
  videoGenerating = false,
  onVideoGeneratingChange
}: Props) {
  const { comfyBusy, ensureComfyOnline } = useComfyUi()
  const [videos, setVideos] = useState<GalleryVideo[]>([])
  const [videoPickerOpen, setVideoPickerOpen] = useState(false)
  const [upscaleModels, setUpscaleModels] = useState<{ name: string; path: string }[]>([])
  const [interpModels, setInterpModels] = useState<{ name: string; path: string }[]>([])
  const [generating, setGenerating] = useState(false)
  const [generateElapsedSec, setGenerateElapsedSec] = useState(0)
  const [sourceFps, setSourceFps] = useState(16)
  const [sourceFrameCount, setSourceFrameCount] = useState<number | null>(null)
  const [videoSize, setVideoSize] = useState<{ width: number; height: number } | null>(null)
  const [resultVideoPath, setResultVideoPath] = useState<string | null>(null)
  const [resultVideoMeta, setResultVideoMeta] = useState<GalleryVideoMeta | null>(null)
  const [confirmDeleteVideo, setConfirmDeleteVideo] = useState(false)

  const abortRef = useRef<AbortController | null>(null)
  const sharedRef = useRef(sharedComfy)
  sharedRef.current = sharedComfy
  const draftRef = useRef(draft)
  draftRef.current = draft
  const videoPickerListRef = useRef<HTMLDivElement | null>(null)
  const resultGalleryRef = useRef<HTMLDivElement | null>(null)
  const sourceVideoRef = useRef<HTMLVideoElement | null>(null)
  const resultVideoRef = useRef<HTMLVideoElement | null>(null)
  const syncLockRef = useRef(false)
  const compareSourceByResultRef = useRef<Map<string, string>>(loadCompareSourceMap())
  const resultVideoPathRef = useRef(resultVideoPath)
  resultVideoPathRef.current = resultVideoPath
  const upscaleVideosRef = useRef<GalleryVideo[]>([])

  const patchDraft = useCallback(
    (partial: Partial<UpscaleGenerateDraft>) => {
      onDraftChange({ ...draftRef.current, ...partial })
    },
    [onDraftChange]
  )

  const dismissVideoPicker = useCallback(() => setVideoPickerOpen(false), [])
  const videoPickerBackdrop = useBackdropDismiss(dismissVideoPicker)

  const refreshGallery = useCallback(async () => {
    const folder = sharedRef.current.outputFolder.trim()
    if (!folder) {
      setVideos([])
      setResultVideoPath(null)
      return
    }
    try {
      const res = await window.api.galleryListVideos({ outputFolder: folder })
      if (!res.ok) {
        setVideos([])
        return
      }
      setVideos(res.videos)
      const upscaleList = res.videos.filter((v) => isUpscaleVideoName(v.name))
      setResultVideoPath((prev) => {
        if (prev && upscaleList.some((v) => v.path === prev)) return prev
        return upscaleList[0]?.path ?? null
      })
    } catch {
      setVideos([])
    }
  }, [])

  const upscaleVideos = useMemo(
    () => videos.filter((v) => isUpscaleVideoName(v.name)),
    [videos]
  )
  upscaleVideosRef.current = upscaleVideos

  const compareSourcePath = useMemo(
    () =>
      resolveCompareSourcePath(
        resultVideoPath,
        videos,
        draft.selectedVideoPath,
        'upscale',
        resultVideoPath ? lookupCompareSource(compareSourceByResultRef.current, resultVideoPath) : undefined
      ),
    [resultVideoPath, videos, draft.selectedVideoPath]
  )

  const syncVideos = useCallback((from: HTMLVideoElement, to: HTMLVideoElement | null) => {
    if (!to || syncLockRef.current) return
    syncLockRef.current = true
    try {
      if (Math.abs(to.currentTime - from.currentTime) > 0.12) {
        to.currentTime = from.currentTime
      }
      if (from.paused && !to.paused) to.pause()
      if (!from.paused && to.paused) void to.play().catch(() => undefined)
    } finally {
      window.setTimeout(() => {
        syncLockRef.current = false
      }, 40)
    }
  }, [])

  useEffect(() => {
    const src = sourceVideoRef.current
    const res = resultVideoRef.current
    if (!resultVideoPath) return
    if (src) src.currentTime = 0
    if (res) res.currentTime = 0
    void src?.play().catch(() => undefined)
    void res?.play().catch(() => undefined)
  }, [compareSourcePath, resultVideoPath])

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
            seed: res.info.seed ?? null
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
            seed: null
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

  useEffect(() => {
    if (!active) return
    void refreshGallery()
  }, [active, sharedComfy.outputFolder, refreshGallery])

  useEffect(() => {
    const path = draft.selectedVideoPath.trim()
    if (!path) {
      setSourceFps(16)
      setSourceFrameCount(null)
      setVideoSize(null)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const res = await window.api.galleryProbeVideo({ path })
        if (cancelled) return
        const fps = res.ok && res.info?.fps != null ? Number(res.info.fps) : NaN
        if (Number.isFinite(fps) && fps > 0) {
          setSourceFps(Math.min(240, Math.max(1, Math.round(fps * 1000) / 1000)))
        } else {
          setSourceFps(16)
        }
        const frames = res.ok && res.info?.frameCount != null ? Number(res.info.frameCount) : NaN
        if (Number.isFinite(frames) && frames > 0) {
          setSourceFrameCount(Math.round(frames))
        } else {
          setSourceFrameCount(null)
        }
        const w = res.ok ? res.info?.width : null
        const h = res.ok ? res.info?.height : null
        if (typeof w === 'number' && w > 0 && typeof h === 'number' && h > 0) {
          setVideoSize({ width: w, height: h })
        } else {
          setVideoSize(null)
        }
      } catch {
        if (!cancelled) {
          setSourceFps(16)
          setSourceFrameCount(null)
          setVideoSize(null)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [draft.selectedVideoPath])

  useEffect(() => {
    const folder = sharedComfy.upscaleModelFolder.trim()
    if (!folder) {
      setUpscaleModels([])
      return
    }
    let cancelled = false
    void window.api.listModelFiles(folder).then((files) => {
      if (!cancelled) setUpscaleModels(files)
    })
    return () => {
      cancelled = true
    }
  }, [sharedComfy.upscaleModelFolder])

  useEffect(() => {
    const folder = sharedComfy.frameInterpModelFolder.trim()
    if (!folder) {
      setInterpModels([])
      return
    }
    let cancelled = false
    void window.api.listModelFiles(folder).then((files) => {
      if (!cancelled) setInterpModels(files)
    })
    return () => {
      cancelled = true
    }
  }, [sharedComfy.frameInterpModelFolder])

  const videoPaths = useMemo(() => videos.map((v) => v.path), [videos])
  const upscaleVideoPaths = useMemo(() => upscaleVideos.map((v) => v.path), [upscaleVideos])

  useArrowListNav({
    enabled: active && videoPickerOpen && videoPaths.length > 0,
    items: videoPaths,
    selectedId: draft.selectedVideoPath || null,
    onSelect: (id) => {
      patchDraft({ selectedVideoPath: id })
      setVideoPickerOpen(false)
    },
    columns: 'auto',
    containerRef: videoPickerListRef,
    shouldIgnore: () => Boolean(document.querySelector('.settings-modal, .confirm-modal'))
  })

  useArrowListNav({
    enabled:
      active &&
      !videoPickerOpen &&
      !generating &&
      !confirmDeleteVideo &&
      upscaleVideoPaths.length > 0,
    items: upscaleVideoPaths,
    selectedId: resultVideoPath,
    onSelect: (id) => setResultVideoPath(id),
    columns: 1,
    containerRef: resultGalleryRef,
    shouldIgnore: () =>
      Boolean(
        document.querySelector(
          '.settings-modal, .confirm-modal, .setup-incomplete-modal, .generate-image-picker-modal'
        )
      )
  })

  useEffect(() => {
    if (!active || videoPickerOpen || generating || confirmDeleteVideo) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Delete') return
      if (e.defaultPrevented) return
      if (e.altKey || e.ctrlKey || e.metaKey) return
      if (isTextEntryTarget(e.target)) return
      if (
        document.querySelector(
          '.settings-modal, .confirm-modal, .setup-incomplete-modal, .generate-image-picker-modal'
        )
      ) {
        return
      }
      if (!resultVideoPathRef.current) return
      e.preventDefault()
      e.stopPropagation()
      setConfirmDeleteVideo(true)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [active, videoPickerOpen, generating, confirmDeleteVideo])

  const performDeleteVideo = useCallback(async () => {
    const path = resultVideoPathRef.current
    setConfirmDeleteVideo(false)
    if (!path) return
    const res = await window.api.trashItem(path)
    if (!res.ok) {
      onStatus(res.error || 'Failed to move video to Recycle Bin', true)
      return
    }
    forgetCompareSource(compareSourceByResultRef.current, path)
    const list = upscaleVideosRef.current
    const idx = list.findIndex((v) => v.path === path)
    const nextList = list.filter((v) => v.path !== path)
    setVideos((prev) => prev.filter((v) => v.path !== path))
    const nextPath = nextList[idx]?.path ?? nextList[idx - 1]?.path ?? null
    setResultVideoPath(nextPath)
    if (draftRef.current.selectedVideoPath === path) {
      patchDraft({ selectedVideoPath: '' })
    }
    onStatus(`Moved to Recycle Bin: ${basenamePath(path)}`)
  }, [onStatus, patchDraft])

  useEffect(() => {
    if (!active || !videoPickerOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setVideoPickerOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, videoPickerOpen])

  const ensureOnlineForUpscale = async (): Promise<boolean> => {
    const s = sharedRef.current
    return ensureComfyOnline({
      ditFolders: uniqueDirs([s.highDitPath, s.lowDitPath], [s.ditModelFolder]),
      vaeFolders: uniqueDirs([s.vaePath]),
      clipFolders: uniqueDirs([s.clipPath]),
      loraFolders: uniqueDirs([], [s.speedLoraFolder, s.wan22LoraFolder]),
      upscaleFolders: uniqueDirs([draftRef.current.upscaleModelPath], [s.upscaleModelFolder]),
      frameInterpFolders: uniqueDirs(
        [draftRef.current.interpolationModelPath],
        [s.frameInterpModelFolder]
      )
    })
  }

  const abortUpscale = async () => {
    abortRef.current?.abort()
    try {
      await interruptComfyGeneration(COMFY_BASE_URL)
    } catch {
      /* ignore */
    }
  }

  const runUpscale = async () => {
    const s = sharedRef.current
    const d = draftRef.current
    const videoPath = d.selectedVideoPath.trim()
    const resolutionPreset = isResolutionPreset(d.resolutionPreset)
      ? d.resolutionPreset
      : DEFAULT_RESOLUTION_PRESET
    const interpolationScale = Math.max(1, Math.round(d.interpolationScale))
    const aspectW = videoSize?.width || 544
    const aspectH = videoSize?.height || 960
    const { width: targetWidth, height: targetHeight } = resolveWanResolution({
      resolutionPreset,
      aspectW,
      aspectH
    })

    if (!videoPath) {
      onStatus('Choose a video to upscale', true)
      return
    }
    if (!s.outputFolder.trim()) {
      onStatus('Set Output folder in Settings → ComfyUI', true)
      return
    }

    const report = (detail: string) => {
      onStatus(detail, false, { sticky: true })
    }

    report('Checking ComfyUI online (Upscale)…')
    const online = await ensureOnlineForUpscale()
    if (!online) return

    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac
    setGenerateElapsedSec(0)
    setGenerating(true)
    onVideoGeneratingChange?.(true)
    const startedAt = Date.now()

    const formatElapsed = (ms: number) => {
      const totalSec = Math.max(0, Math.round(ms / 1000))
      const m = Math.floor(totalSec / 60)
      const sec = totalSec % 60
      if (m <= 0) return `${sec}s`
      return `${m}m ${sec}s`
    }

    const elapsedTimer = window.setInterval(() => {
      setGenerateElapsedSec(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)))
    }, 250)

    try {
      report('Unloading Local AI models…')
      try {
        const unloaded = await unloadLocalAiModels(settings)
        const parts: string[] = []
        if (unloaded.ollamaUnloaded.length) {
          parts.push(`Ollama: ${unloaded.ollamaUnloaded.join(', ')}`)
        }
        if (unloaded.lmStudioUnloaded.length) {
          parts.push(`LM Studio: ${unloaded.lmStudioUnloaded.join(', ')}`)
        }
        for (const n of unloaded.notes) parts.push(n)
        if (parts.length > 0) {
          report(`Local AI unloaded — ${parts.join(' · ')}`)
        }
      } catch (err) {
        report(`Local AI unload skipped: ${err instanceof Error ? err.message : String(err)}`)
      }

      report(`Uploading video… (${basenamePath(videoPath)})`)
      const uploaded = await window.api.comfyUploadVideo({
        videoPath,
        baseUrl: COMFY_BASE_URL
      })

      report(
        `ComfyUI upscale: ${resolutionPreset} → ${targetWidth}×${targetHeight}, interp ${interpolationScale}, fps ${sourceFps}`
      )
      const result = await generateUpscaleWithComfy(
        {
          uploadedVideoName: uploaded.name,
          uploadedVideoSubfolder: uploaded.subfolder,
          upscaleModelName: d.upscaleModelPath.trim()
            ? basenamePath(d.upscaleModelPath)
            : undefined,
          targetWidth,
          targetHeight,
          interpolationScale,
          interpolationModelName: d.interpolationModelPath.trim()
            ? basenamePath(d.interpolationModelPath)
            : undefined,
          fps: sourceFps,
          removeLastFrame: Boolean(d.removeLastFrame),
          savePrefix: 'upscale/Wan2.2',
          videoFormat: s.videoFormat,
          videoCodec: s.videoCodec,
          videoBitDepth: s.videoBitDepth,
          videoCrf: s.videoCrf
        },
        {
          signal: ac.signal,
          baseUrl: COMFY_BASE_URL,
          onProgress: (msg) => {
            if (ac.signal.aborted) return
            onStatus(msg, false, { sticky: true })
          }
        }
      )

      if (ac.signal.aborted) return

      const videoRefOut = result.videos[0]
      report(
        `Resolve output… (${videoRefOut.subfolder ? `${videoRefOut.subfolder}/` : ''}${videoRefOut.filename})`
      )
      const resolved = await window.api.comfyResolveImagePath({
        filename: videoRefOut.filename,
        subfolder: videoRefOut.subfolder,
        type: videoRefOut.type
      })
      if (!resolved.ok || !resolved.path) {
        throw new Error(resolved.error || 'Could not resolve ComfyUI video path')
      }

      report(`Save to gallery… → ${s.outputFolder.trim()}`)
      const sourceName = basenamePath(videoPath)
      const dot = sourceName.lastIndexOf('.')
      const sourceStem = dot > 0 ? sourceName.slice(0, dot) : sourceName
      const upscaleBase = /_upscale$/i.test(sourceStem) ? sourceStem : `${sourceStem}_upscale`
      const saved = await window.api.gallerySaveVideo({
        sourcePath: resolved.path,
        outputFolder: s.outputFolder.trim(),
        fileName: upscaleBase
      })
      if (!saved.ok || !saved.path) {
        throw new Error(saved.error || 'Failed to save video to gallery')
      }

      rememberCompareSource(compareSourceByResultRef.current, saved.path, videoPath)
      await refreshGallery()
      setResultVideoPath(saved.path)

      const elapsed = formatElapsed(Date.now() - startedAt)
      onStatus(
        `Done — ${resolutionPreset} ${targetWidth}×${targetHeight}, Interp ×${interpolationScale}, ${elapsed}`,
        false,
        { sticky: true }
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg === 'Upscale cancelled' || msg === 'Generation cancelled') {
        onStatus('Upscale cancelled')
        return
      }
      onStatus(msg, true)
    } finally {
      window.clearInterval(elapsedTimer)
      if (abortRef.current === ac) abortRef.current = null
      setGenerating(false)
      setGenerateElapsedSec(0)
      onVideoGeneratingChange?.(false)
    }
  }

  const selectedVideo =
    videos.find((v) => v.path === draft.selectedVideoPath) ||
    (draft.selectedVideoPath.trim()
      ? {
          path: draft.selectedVideoPath,
          name: basenamePath(draft.selectedVideoPath),
          mtimeMs: 0
        }
      : undefined)
  const modelFolder = sharedComfy.upscaleModelFolder.trim()
  const modelValue = draft.upscaleModelPath
  const modelKnown = upscaleModels.some((m) => m.path === modelValue)
  const modelOptions = [
    ...(!modelKnown && modelValue
      ? [{ value: modelValue, label: `${basenamePath(modelValue)} (not in folder)` }]
      : []),
    ...upscaleModels.map((m) => ({ value: m.path, label: m.name }))
  ]
  const interpFolder = sharedComfy.frameInterpModelFolder.trim()
  const interpValue = draft.interpolationModelPath
  const interpKnown = interpModels.some((m) => m.path === interpValue)
  const interpOptions = [
    ...(!interpKnown && interpValue
      ? [{ value: interpValue, label: `${basenamePath(interpValue)} (not in folder)` }]
      : []),
    ...interpModels.map((m) => ({ value: m.path, label: m.name }))
  ]

  return (
    <div className="generate-view upscale-view">
      <div className="generate-body">
        <aside className="generate-settings">
          <div className="generate-settings-scroll upscale-settings-scroll">
            <div className="generate-settings-col">
              <div className="field">
                <span>Video (Output folder)</span>
                {!sharedComfy.outputFolder.trim() ? (
                  <p className="field-hint">Set Output folder in Settings → ComfyUI.</p>
                ) : videos.length === 0 && !selectedVideo ? (
                  <p className="field-hint">No videos in output folder yet.</p>
                ) : !selectedVideo ? (
                  <button
                    type="button"
                    className="generate-selected-image-btn is-empty"
                    onClick={() => setVideoPickerOpen(true)}
                  >
                    Click to choose video
                  </button>
                ) : (
                  <button
                    type="button"
                    className="generate-selected-image-btn upscale-selected-video-btn"
                    title={selectedVideo.name}
                    onClick={() => setVideoPickerOpen(true)}
                  >
                    <video
                      key={selectedVideo.path}
                      src={window.api.toLocalUrl(selectedVideo.path)}
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
                <p className="field-hint">
                  {basenamePath(draft.selectedVideoPath) || 'No video selected'}
                </p>
              </div>

              <label className="field">
                <span>Upscale model</span>
                <SearchableSelect
                  value={modelKnown ? modelValue : modelValue ? modelValue : ''}
                  options={modelOptions}
                  disabled={!modelFolder || upscaleModels.length === 0}
                  placeholder={
                    !modelFolder
                      ? 'Set Upscale model folder in Settings'
                      : upscaleModels.length === 0
                        ? 'No models in folder'
                        : 'Select upscale model…'
                  }
                  onChange={(next) => patchDraft({ upscaleModelPath: next })}
                />
              </label>

              <label className="field">
                <span>Upscale Resolution</span>
                <select
                  value={
                    isResolutionPreset(draft.resolutionPreset)
                      ? draft.resolutionPreset
                      : DEFAULT_RESOLUTION_PRESET
                  }
                  onChange={(e) => patchDraft({ resolutionPreset: e.target.value })}
                >
                  {RESOLUTION_PRESET_OPTIONS.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
                <p className="field-hint">
                  {(() => {
                    const preset = isResolutionPreset(draft.resolutionPreset)
                      ? draft.resolutionPreset
                      : DEFAULT_RESOLUTION_PRESET
                    const curW = videoSize?.width
                    const curH = videoSize?.height
                    const { width, height } = resolveWanResolution({
                      resolutionPreset: preset,
                      aspectW: curW || 544,
                      aspectH: curH || 960
                    })
                    const from =
                      curW && curH ? `${curW}×${curH}` : draft.selectedVideoPath.trim() ? '…' : '—'
                    return `${from} > ${width}×${height}`
                  })()}
                </p>
              </label>

              <label className="field">
                <span>Interpolation model</span>
                <SearchableSelect
                  value={interpKnown ? interpValue : interpValue ? interpValue : ''}
                  options={interpOptions}
                  disabled={!interpFolder || interpModels.length === 0}
                  placeholder={
                    !interpFolder
                      ? 'Set Frame Interpolation model folder in Settings'
                      : interpModels.length === 0
                        ? 'No models in folder'
                        : 'Select interpolation model…'
                  }
                  onChange={(next) => patchDraft({ interpolationModelPath: next })}
                />
              </label>

              <label className="field">
                <span>Interpolation scale</span>
                <input
                  type="number"
                  min={1}
                  max={16}
                  step={1}
                  value={draft.interpolationScale}
                  onChange={(e) => patchDraft({ interpolationScale: Number(e.target.value) })}
                />
                <p className="field-hint">
                  {(() => {
                    const scale = Math.max(1, Math.round(Number(draft.interpolationScale) || 1))
                    if (!draft.selectedVideoPath.trim()) return '— > — frames'
                    if (sourceFrameCount == null || sourceFrameCount <= 0) {
                      return `… > … frames`
                    }
                    let to = Math.max(1, sourceFrameCount * scale)
                    if (draft.removeLastFrame && to > 1) to -= 1
                    return `${sourceFrameCount} > ${to} frames`
                  })()}
                </p>
              </label>

              <div
                className={`generate-aspect-toggle lora-toggle${draft.removeLastFrame ? ' is-on' : ''}`}
              >
                <span className="lora-toggle-label">Remove last frame</span>
                <button
                  type="button"
                  className="lora-switch"
                  role="switch"
                  aria-checked={draft.removeLastFrame}
                  aria-label="Remove last frame"
                  onClick={() => patchDraft({ removeLastFrame: !draft.removeLastFrame })}
                >
                  <span className="lora-switch-knob" />
                </button>
              </div>
            </div>
          </div>

          <div className="generate-actions">
            {generating ? (
              <button
                type="button"
                className="danger lora-test-generate-btn"
                onClick={() => void abortUpscale()}
              >
                Abort · {generateElapsedSec} Sec
              </button>
            ) : (
              <button
                type="button"
                className="primary lora-test-generate-btn"
                disabled={comfyBusy || videoGenerating}
                title={
                  videoGenerating ? 'Another panel is generating — Local AI is paused' : undefined
                }
                onClick={() => void runUpscale()}
              >
                Upscale
              </button>
            )}
          </div>
        </aside>

        <section className="generate-gallery upscale-result-pane">
          <div className="generate-gallery-header">
            <span>
              {upscaleVideos.length} video{upscaleVideos.length === 1 ? '' : 's'}
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

          <div className="generate-video-player upscale-result-player face-compare-player">
            {resultVideoPath ? (
              <div className="face-compare-grid">
                <div className="face-compare-pane">
                  <div className="face-compare-label">Original</div>
                  {compareSourcePath ? (
                    <video
                      key={`src-${compareSourcePath}`}
                      ref={sourceVideoRef}
                      src={window.api.toLocalUrl(compareSourcePath)}
                      controls
                      muted
                      loop
                      playsInline
                      autoPlay
                      onLoadedData={(e) => {
                        void e.currentTarget.play().catch(() => undefined)
                      }}
                      onPlay={(e) => syncVideos(e.currentTarget, resultVideoRef.current)}
                      onPause={(e) => syncVideos(e.currentTarget, resultVideoRef.current)}
                      onSeeked={(e) => syncVideos(e.currentTarget, resultVideoRef.current)}
                      onTimeUpdate={(e) => {
                        const other = resultVideoRef.current
                        if (!other || other.paused) return
                        if (Math.abs(other.currentTime - e.currentTarget.currentTime) > 0.25) {
                          syncVideos(e.currentTarget, other)
                        }
                      }}
                    />
                  ) : (
                    <div className="generate-video-player-empty face-compare-missing">
                      original video not found
                    </div>
                  )}
                </div>
                <div className="face-compare-pane">
                  <div className="face-compare-label">Upscaled</div>
                  <video
                    key={`up-${resultVideoPath}`}
                    ref={resultVideoRef}
                    src={window.api.toLocalUrl(resultVideoPath)}
                    controls
                    loop
                    playsInline
                    autoPlay
                    onLoadedData={(e) => {
                      void e.currentTarget.play().catch(() => undefined)
                    }}
                    onLoadedMetadata={(e) => {
                      const el = e.currentTarget
                      const w = el.videoWidth
                      const h = el.videoHeight
                      if (!w || !h) return
                      setResultVideoMeta((prev) => {
                        if (!prev) return prev
                        if (prev.width && prev.height) return prev
                        return { ...prev, width: w, height: h }
                      })
                    }}
                    onPlay={(e) => syncVideos(e.currentTarget, sourceVideoRef.current)}
                    onPause={(e) => syncVideos(e.currentTarget, sourceVideoRef.current)}
                    onSeeked={(e) => syncVideos(e.currentTarget, sourceVideoRef.current)}
                    onTimeUpdate={(e) => {
                      const other = sourceVideoRef.current
                      if (!other || other.paused) return
                      if (Math.abs(other.currentTime - e.currentTarget.currentTime) > 0.25) {
                        syncVideos(e.currentTarget, other)
                      }
                    }}
                  />
                </div>
              </div>
            ) : (
              <div className="generate-video-player-empty">
                {upscaleVideos.length > 0
                  ? 'Select a video below to preview'
                  : sharedComfy.outputFolder.trim()
                    ? 'No upscale videos in output folder yet'
                    : 'Choose an output folder in Settings'}
              </div>
            )}
            {resultVideoPath && resultVideoMeta ? (
              <GalleryVideoMetaBar meta={resultVideoMeta} onStatus={onStatus} />
            ) : null}
          </div>

          <div className="i2v-gallery" ref={resultGalleryRef}>
            {upscaleVideos.length === 0 ? (
              <div className="i2v-gallery-empty">No upscale videos</div>
            ) : (
              upscaleVideos.map((v) => (
                <button
                  key={v.path}
                  type="button"
                  data-nav-id={v.path}
                  className={`i2v-gallery-item${v.path === resultVideoPath ? ' active' : ''}`}
                  onClick={() => {
                    setResultVideoPath(v.path)
                    const src = resolveCompareSourcePath(
                      v.path,
                      videos,
                      draftRef.current.selectedVideoPath,
                      'upscale',
                      lookupCompareSource(compareSourceByResultRef.current, v.path)
                    )
                    if (src) {
                      rememberCompareSource(compareSourceByResultRef.current, v.path, src)
                      if (src !== draftRef.current.selectedVideoPath) {
                        patchDraft({ selectedVideoPath: src })
                      }
                    }
                  }}
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
              {videos.map((v) => {
                const isActive = v.path === draft.selectedVideoPath
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
                      patchDraft({ selectedVideoPath: v.path })
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
        onConfirm={() => void performDeleteVideo()}
      />
    </div>
  )
}
