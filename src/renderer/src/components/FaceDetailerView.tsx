import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppSettings, FaceDetailerDraft, SharedComfyDraft } from '../types'
import { basenamePath } from '../services/comfyI2v'
import {
  COMFY_BASE_URL,
  generateFaceDetailerWithComfy,
  interruptComfyGeneration,
  probeFaceDetailerNodeCaps
} from '../services/comfyFaceDetailer'
import { unloadLocalAiModels } from '../services/unloadLocalAi'
import { isTextEntryTarget, useArrowListNav } from '../hooks/useArrowListNav'
import { useBackdropDismiss } from '../hooks/useBackdropDismiss'
import { ConfirmDialog } from './ConfirmDialog'
import { ResourceMonitorPane } from './ResourceMonitorPane'
import { SearchableSelect } from './SearchableSelect'
import { uniqueDirs, useComfyUi } from './ComfyUiContext'
import { splitModelsByHighLow } from '../utils/highLowModelSplit'

interface Props {
  active?: boolean
  settings: AppSettings
  sharedComfy: SharedComfyDraft
  draft: FaceDetailerDraft
  onSharedComfyChange: (shared: SharedComfyDraft) => void
  onDraftChange: (draft: FaceDetailerDraft) => void
  onStatus: (msg: string, isError?: boolean, options?: { sticky?: boolean }) => void
  videoGenerating?: boolean
  onVideoGeneratingChange?: (generating: boolean) => void
}

interface GalleryVideo {
  path: string
  name: string
  mtimeMs: number
}

function isFaceVideoName(name: string): boolean {
  return /_face/i.test(name)
}

function stripExt(name: string): string {
  return name.replace(/\.[^.]+$/, '')
}

/** Gallery collision rename: `stem_1712345678901`. */
function stripCollisionSuffix(stem: string): string {
  return stem.replace(/_\d{10,}$/u, '')
}

function videoBaseName(name: string): string {
  return stripCollisionSuffix(stripExt(name))
}

/** Strip trailing `_face` (and collision digits) to recover the source stem. */
function sourceStemFromFaceName(name: string): string | null {
  const base = videoBaseName(name)
  if (/_face$/i.test(base)) return base.replace(/_face$/i, '')
  return null
}

function resolveCompareSourcePath(
  resultPath: string | null,
  videos: GalleryVideo[],
  selectedSourcePath: string,
  rememberedPath?: string | null
): string | null {
  if (!resultPath) return null

  const remembered = (rememberedPath || '').trim()
  if (
    remembered &&
    remembered !== resultPath &&
    !isFaceVideoName(basenamePath(remembered))
  ) {
    const listed = videos.some((v) => v.path === remembered)
    const selected = selectedSourcePath.trim()
    if (listed || remembered === selected || videos.length === 0) {
      return remembered
    }
  }

  const stem = sourceStemFromFaceName(basenamePath(resultPath))
  if (stem) {
    const match = videos.find((v) => {
      if (v.path === resultPath) return false
      if (isFaceVideoName(v.name)) return false
      return videoBaseName(v.name) === stem
    })
    if (match) return match.path

    // Only use left-panel selection when it matches this result's stem.
    const selected = selectedSourcePath.trim()
    if (
      selected &&
      selected !== resultPath &&
      !isFaceVideoName(basenamePath(selected)) &&
      videoBaseName(basenamePath(selected)) === stem
    ) {
      return selected
    }
    return null
  }

  const selected = selectedSourcePath.trim()
  if (selected && selected !== resultPath && !isFaceVideoName(basenamePath(selected))) {
    return selected
  }
  return null
}

export function FaceDetailerView({
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
  const [ditModels, setDitModels] = useState<{ name: string; path: string }[]>([])
  const [speedLoraModels, setSpeedLoraModels] = useState<{ name: string; path: string }[]>([])
  const [bboxModels, setBboxModels] = useState<string[]>([])
  const [generating, setGenerating] = useState(false)
  const [generateElapsedSec, setGenerateElapsedSec] = useState(0)
  const [sourceFps, setSourceFps] = useState(16)
  const [sourceFrameCount, setSourceFrameCount] = useState<number | null>(null)
  const [resultVideoPath, setResultVideoPath] = useState<string | null>(null)
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
  const compareSourceByResultRef = useRef<Map<string, string>>(new Map())
  const resultVideoPathRef = useRef(resultVideoPath)
  resultVideoPathRef.current = resultVideoPath
  const faceVideosRef = useRef<GalleryVideo[]>([])

  const patchDraft = useCallback(
    (partial: Partial<FaceDetailerDraft>) => {
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
      const faceList = res.videos.filter((v) => isFaceVideoName(v.name))
      setResultVideoPath((prev) => {
        if (prev && faceList.some((v) => v.path === prev)) return prev
        return faceList[0]?.path ?? null
      })
    } catch {
      setVideos([])
    }
  }, [])

  const faceVideos = useMemo(() => videos.filter((v) => isFaceVideoName(v.name)), [videos])
  faceVideosRef.current = faceVideos

  const compareSourcePath = useMemo(
    () =>
      resolveCompareSourcePath(
        resultVideoPath,
        videos,
        draft.selectedVideoPath,
        resultVideoPath ? compareSourceByResultRef.current.get(resultVideoPath) : undefined
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
    if (!active) return
    void refreshGallery()
  }, [active, sharedComfy.outputFolder, refreshGallery])

  useEffect(() => {
    const path = draft.selectedVideoPath.trim()
    if (!path) {
      setSourceFps(16)
      setSourceFrameCount(null)
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
      } catch {
        if (!cancelled) {
          setSourceFps(16)
          setSourceFrameCount(null)
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
    const folder = sharedComfy.ditModelFolder.trim()
    if (!folder) {
      setDitModels([])
      return
    }
    let cancelled = false
    void window.api.listModelFiles(folder).then((files) => {
      if (!cancelled) setDitModels(files)
    })
    return () => {
      cancelled = true
    }
  }, [sharedComfy.ditModelFolder])

  useEffect(() => {
    const folder = sharedComfy.speedLoraFolder.trim()
    if (!folder) {
      setSpeedLoraModels([])
      return
    }
    let cancelled = false
    void window.api.listModelFiles(folder).then((files) => {
      if (!cancelled) setSpeedLoraModels(files)
    })
    return () => {
      cancelled = true
    }
  }, [sharedComfy.speedLoraFolder])

  useEffect(() => {
    if (!active) return
    let cancelled = false
    void (async () => {
      try {
        const caps = await probeFaceDetailerNodeCaps(COMFY_BASE_URL)
        if (cancelled) return
        setBboxModels(caps.bboxModelOptions)
        if (
          caps.bboxModelOptions.length > 0 &&
          draftRef.current.bboxModelName &&
          !caps.bboxModelOptions.includes(draftRef.current.bboxModelName)
        ) {
          const preferred =
            caps.bboxModelOptions.find((n) => /face/i.test(n) && /anime|99coins/i.test(n)) ||
            caps.bboxModelOptions.find((n) => /face/i.test(n)) ||
            caps.bboxModelOptions[0]
          if (preferred) patchDraft({ bboxModelName: preferred })
        }
      } catch {
        if (!cancelled) setBboxModels([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [active, patchDraft])

  const videoPaths = useMemo(() => videos.map((v) => v.path), [videos])
  const faceVideoPaths = useMemo(() => faceVideos.map((v) => v.path), [faceVideos])
  const ditModelsBySide = useMemo(() => splitModelsByHighLow(ditModels), [ditModels])
  const speedLoraModelsBySide = useMemo(
    () => splitModelsByHighLow(speedLoraModels),
    [speedLoraModels]
  )

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
      faceVideoPaths.length > 0,
    items: faceVideoPaths,
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
    compareSourceByResultRef.current.delete(path)
    const list = faceVideosRef.current
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

  const ensureOnlineForFace = async (): Promise<boolean> => {
    const s = sharedRef.current
    const d = draftRef.current
    return ensureComfyOnline({
      ditFolders: uniqueDirs([d.lowDitPath], [s.ditModelFolder]),
      vaeFolders: uniqueDirs([s.vaePath]),
      clipFolders: uniqueDirs([s.clipPath]),
      loraFolders: uniqueDirs([d.loraLowPath], [s.speedLoraFolder, s.wan22LoraFolder]),
      upscaleFolders: uniqueDirs([d.upscaleModelPath], [s.upscaleModelFolder])
    })
  }

  const abortFace = async () => {
    abortRef.current?.abort()
    try {
      await interruptComfyGeneration(COMFY_BASE_URL)
    } catch {
      /* ignore */
    }
  }

  const runFaceDetailer = async () => {
    const s = sharedRef.current
    const d = draftRef.current
    const videoPath = d.selectedVideoPath.trim()

    if (!videoPath) {
      onStatus('Choose a video for Face Detailer', true)
      return
    }
    if (!s.outputFolder.trim()) {
      onStatus('Set Output folder in Settings → ComfyUI', true)
      return
    }
    if (!d.lowDitPath.trim() || !s.vaePath.trim() || !s.clipPath.trim()) {
      onStatus('Set Low noise DiT here, and VAE / CLIP in Settings → ComfyUI', true)
      return
    }

    const report = (detail: string) => {
      onStatus(detail, false, { sticky: true })
    }

    report('Checking ComfyUI online (Face Detailer)…')
    const online = await ensureOnlineForFace()
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

      const speedLowOn = Boolean(d.loraLowEnabled && d.loraLowPath.trim())
      report(
        `ComfyUI Face Detailer: thresh ${d.bboxThreshold}, steps ${d.steps} (denoise start at step ${d.startAtStep}), fps ${sourceFps}`
      )
      const result = await generateFaceDetailerWithComfy(
        {
          uploadedVideoName: uploaded.name,
          uploadedVideoSubfolder: uploaded.subfolder,
          lowDitName: basenamePath(d.lowDitPath),
          loraLowName: speedLowOn ? basenamePath(d.loraLowPath) : undefined,
          loraLowStrength: d.loraLowStrength,
          vaeName: basenamePath(s.vaePath),
          clipName: basenamePath(s.clipPath),
          bboxModelName: d.bboxModelName.trim(),
          upscaleModelName: d.upscaleModelPath.trim()
            ? basenamePath(d.upscaleModelPath)
            : undefined,
          bboxThreshold: d.bboxThreshold,
          cropFactor: d.cropFactor,
          takeCount: d.takeCount,
          minFaceWidth: d.minFaceWidth,
          feather: d.feather,
          steps: d.steps,
          startAtStep: d.startAtStep,
          endAtStep: d.steps,
          cfg: d.cfg,
          sampler: d.sampler,
          scheduler: d.scheduler,
          positive: d.positive,
          negative: d.negative,
          seed: d.seed,
          shift: d.shift,
          fps: sourceFps,
          savePrefix: 'face/Wan2.2',
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
      const faceBase = /_face$/i.test(sourceStem) ? sourceStem : `${sourceStem}_face`
      const saved = await window.api.gallerySaveVideo({
        sourcePath: resolved.path,
        outputFolder: s.outputFolder.trim(),
        fileName: faceBase
      })
      if (!saved.ok || !saved.path) {
        throw new Error(saved.error || 'Failed to save video to gallery')
      }

      compareSourceByResultRef.current.set(saved.path, videoPath)
      await refreshGallery()
      setResultVideoPath(saved.path)

      const elapsed = formatElapsed(Date.now() - startedAt)
      onStatus(`Done — Face Detailer, ${elapsed}`, false, { sticky: true })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg === 'Face Detailer cancelled' || msg === 'Generation cancelled') {
        onStatus('Face Detailer cancelled')
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
    { value: '', label: '(none — skip face crop upscale)' },
    ...(!modelKnown && modelValue
      ? [{ value: modelValue, label: `${basenamePath(modelValue)} (not in folder)` }]
      : []),
    ...upscaleModels.map((m) => ({ value: m.path, label: m.name }))
  ]

  const ditFolder = sharedComfy.ditModelFolder.trim()
  const lowDitValue = draft.lowDitPath
  const lowDitKnown = ditModelsBySide.low.some((m) => m.path === lowDitValue)
  const lowDitOptions = [
    ...(!lowDitKnown && lowDitValue
      ? [{ value: lowDitValue, label: `${basenamePath(lowDitValue)} (not in folder)` }]
      : []),
    ...ditModelsBySide.low.map((m) => ({ value: m.path, label: m.name }))
  ]

  const speedLowEnabled = Boolean(draft.loraLowEnabled)
  const speedLowValue = draft.loraLowPath
  const speedLowKnown = speedLoraModelsBySide.low.some((m) => m.path === speedLowValue)
  const speedLowOptions = [
    ...(!speedLowKnown && speedLowValue
      ? [{ value: speedLowValue, label: `${basenamePath(speedLowValue)} (not in folder)` }]
      : []),
    ...speedLoraModelsBySide.low.map((m) => ({ value: m.path, label: m.name }))
  ]

  const stepsValue = Math.max(1, Math.round(Number(draft.steps) || 1))
  const startAtValue = Math.min(
    Math.max(0, stepsValue - 1),
    Math.max(0, Math.round(Number(draft.startAtStep) || 0))
  )

  const bboxOptions = [
    ...(draft.bboxModelName && !bboxModels.includes(draft.bboxModelName)
      ? [{ value: draft.bboxModelName, label: `${draft.bboxModelName} (not listed)` }]
      : []),
    ...bboxModels.map((n) => ({ value: n, label: n }))
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
                  {sourceFrameCount != null ? ` · ${sourceFrameCount} frames · ${sourceFps} fps` : ''}
                </p>
              </div>

              <label className="field">
                <span>Low noise DiT</span>
                <SearchableSelect
                  value={lowDitKnown ? lowDitValue : lowDitValue ? lowDitValue : ''}
                  options={lowDitOptions}
                  disabled={!ditFolder || ditModels.length === 0}
                  placeholder={
                    !ditFolder
                      ? 'Set DiT model folder in Settings'
                      : ditModels.length === 0
                        ? 'No models in folder'
                        : 'Select Low DiT…'
                  }
                  onChange={(next) => patchDraft({ lowDitPath: next })}
                />
              </label>

              <label className="field">
                <span>Speed LoRA (low)</span>
                <div className={`generate-speed-lora-row${speedLowEnabled ? '' : ' is-off'}`}>
                  <button
                    type="button"
                    className={`lora-switch${speedLowEnabled ? ' is-on' : ''}`}
                    role="switch"
                    aria-checked={speedLowEnabled}
                    aria-label="Speed LoRA (low) on/off"
                    title={speedLowEnabled ? 'On' : 'Off'}
                    onClick={() => patchDraft({ loraLowEnabled: !speedLowEnabled })}
                  >
                    <span className="lora-switch-knob" />
                  </button>
                  <SearchableSelect
                    value={speedLowKnown ? speedLowValue : speedLowValue ? speedLowValue : ''}
                    options={speedLowOptions}
                    emptyLabel="-NONE-"
                    placeholder="-NONE-"
                    disabled={!speedLowEnabled}
                    onChange={(next) => patchDraft({ loraLowPath: next })}
                  />
                  <input
                    type="number"
                    className="generate-speed-lora-weight"
                    value={Number(draft.loraLowStrength)}
                    step={0.05}
                    min={0}
                    max={5}
                    title="Weight"
                    disabled={!speedLowEnabled || !speedLowValue}
                    onChange={(e) => patchDraft({ loraLowStrength: Number(e.target.value) })}
                  />
                </div>
              </label>
              {!sharedComfy.speedLoraFolder.trim() ? (
                <p className="field-hint">Set Speed LoRA folder in Settings to list models.</p>
              ) : null}

              <label className="field">
                <span>Face detector (YOLO)</span>
                <SearchableSelect
                  value={draft.bboxModelName}
                  options={bboxOptions}
                  disabled={bboxOptions.length === 0}
                  placeholder={
                    bboxOptions.length === 0
                      ? 'Start ComfyUI to list ultralytics models…'
                      : 'Select bbox model…'
                  }
                  onChange={(next) => patchDraft({ bboxModelName: next })}
                />
              </label>

              <label className="field">
                <span>Face crop upscale model</span>
                <SearchableSelect
                  value={modelKnown || !modelValue ? modelValue : modelValue}
                  options={modelOptions}
                  disabled={false}
                  placeholder={
                    !modelFolder
                      ? 'Optional — set Upscale model folder in Settings'
                      : 'Optional face crop upscale…'
                  }
                  onChange={(next) => patchDraft({ upscaleModelPath: next })}
                />
              </label>

              <label className="field">
                <span>BBox threshold</span>
                <input
                  type="number"
                  min={0.05}
                  max={1}
                  step={0.05}
                  value={draft.bboxThreshold}
                  onChange={(e) => patchDraft({ bboxThreshold: Number(e.target.value) })}
                />
              </label>

              <label className="field">
                <span>Crop factor</span>
                <input
                  type="number"
                  min={1}
                  max={3}
                  step={0.05}
                  value={draft.cropFactor}
                  onChange={(e) => patchDraft({ cropFactor: Number(e.target.value) })}
                />
              </label>

              <label className="field">
                <span>Max faces</span>
                <input
                  type="number"
                  min={1}
                  max={8}
                  step={1}
                  value={draft.takeCount}
                  onChange={(e) => patchDraft({ takeCount: Number(e.target.value) })}
                />
              </label>

              <label className="field">
                <span>Min face detect size</span>
                <input
                  type="number"
                  min={8}
                  max={4096}
                  step={1}
                  value={draft.minFaceWidth}
                  onChange={(e) => patchDraft({ minFaceWidth: Number(e.target.value) })}
                />
              </label>

              <label className="field">
                <span>Paste feather</span>
                <input
                  type="number"
                  min={0}
                  max={255}
                  step={1}
                  value={draft.feather}
                  onChange={(e) => patchDraft({ feather: Number(e.target.value) })}
                />
              </label>

              <div className="generate-steps-refiner-row">
                <label className="field generate-steps-field">
                  <span>Steps</span>
                  <input
                    type="number"
                    min={1}
                    max={50}
                    step={1}
                    disabled={generating}
                    value={stepsValue}
                    onChange={(e) => {
                      const steps = Math.min(
                        50,
                        Math.max(1, Math.round(Number(e.target.value)) || 1)
                      )
                      const startAtStep = Math.min(
                        Math.max(0, steps - 1),
                        Math.max(0, Math.round(Number(draft.startAtStep) || 0))
                      )
                      patchDraft({ steps, startAtStep, endAtStep: steps })
                    }}
                  />
                </label>
                <label className="field generate-refiner-field">
                  <span>{`denoise start at step ${startAtValue}`}</span>
                  <input
                    type="range"
                    min={0}
                    max={Math.max(0, stepsValue - 1)}
                    step={1}
                    disabled={generating || stepsValue <= 1}
                    value={startAtValue}
                    onChange={(e) => {
                      const n = Math.round(Number(e.target.value))
                      const startAtStep = Math.min(
                        Math.max(0, stepsValue - 1),
                        Math.max(0, n)
                      )
                      patchDraft({ startAtStep, endAtStep: stepsValue })
                    }}
                  />
                </label>
              </div>
              <p className="field-hint">End locked to Steps</p>

              <label className="field">
                <span>CFG / seed</span>
                <div className="field-row" style={{ display: 'flex', gap: 8 }}>
                  <input
                    type="number"
                    min={0}
                    max={30}
                    step={0.1}
                    value={draft.cfg}
                    title="CFG"
                    onChange={(e) => patchDraft({ cfg: Number(e.target.value) })}
                  />
                  <input
                    type="number"
                    step={1}
                    value={draft.seed}
                    title="Seed (−1 = random)"
                    onChange={(e) => patchDraft({ seed: Number(e.target.value) })}
                  />
                </div>
              </label>

              <label className="field">
                <span>Positive</span>
                <textarea
                  rows={2}
                  value={draft.positive}
                  onChange={(e) => patchDraft({ positive: e.target.value })}
                />
              </label>

              <label className="field">
                <span>Negative</span>
                <textarea
                  rows={3}
                  value={draft.negative}
                  onChange={(e) => patchDraft({ negative: e.target.value })}
                />
              </label>
            </div>
          </div>

          <div className="generate-actions">
            {generating ? (
              <button
                type="button"
                className="danger lora-test-generate-btn"
                onClick={() => void abortFace()}
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
                onClick={() => void runFaceDetailer()}
              >
                Face Detailer
              </button>
            )}
          </div>
        </aside>

        <section className="generate-gallery upscale-result-pane">
          <div className="generate-gallery-header">
            <span>
              {faceVideos.length} video{faceVideos.length === 1 ? '' : 's'}
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
                  <div className="face-compare-label">Face fixed</div>
                  <video
                    key={`face-${resultVideoPath}`}
                    ref={resultVideoRef}
                    src={window.api.toLocalUrl(resultVideoPath)}
                    controls
                    loop
                    playsInline
                    autoPlay
                    onLoadedData={(e) => {
                      void e.currentTarget.play().catch(() => undefined)
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
                {faceVideos.length > 0
                  ? 'Select a video below to preview'
                  : sharedComfy.outputFolder.trim()
                    ? 'No face videos in output folder yet'
                    : 'Choose an output folder in Settings'}
              </div>
            )}
          </div>

          <div className="i2v-gallery" ref={resultGalleryRef}>
            {faceVideos.length === 0 ? (
              <div className="i2v-gallery-empty">No face videos</div>
            ) : (
              faceVideos.map((v) => (
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
                      compareSourceByResultRef.current.get(v.path)
                    )
                    if (src) {
                      compareSourceByResultRef.current.set(v.path, src)
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
                  <span className="i2v-gallery-name">{v.name}</span>
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
