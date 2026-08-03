import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AppSettings,
  Flf2vGenerateDraft,
  FlfMode,
  I2vGenerateDraft,
  ImageItem,
  SharedComfyDraft,
  VideoGenPanel
} from '../types'
import {
  DEFAULT_FLF2V_GENERATE_DRAFT,
  DEFAULT_I2V_GENERATE_DRAFT,
  framesFromSeconds,
  type VideoGenerateParams
} from '../defaults/i2vGenerate'
import {
  basenamePath,
  COMFY_BASE_URL,
  generateWan22LoopWithComfy,
  interruptComfyGeneration
} from '../services/comfyWan22Loop'
import { useArrowListNav } from '../hooks/useArrowListNav'
import { useBackdropDismiss } from '../hooks/useBackdropDismiss'
import { unloadLocalAiModels } from '../services/unloadLocalAi'
import { generateI2vPromptForImage } from '../services/promptGen'
import { parseSidecarCaption } from '../utils/sidecarCaption'
import { ExtraLoraDialog } from './ExtraLoraDialog'
import { SearchableSelect } from './SearchableSelect'
import { uniqueDirs, useComfyUi } from './ComfyUiContext'
import {
  ASPECT_PRESET_OPTIONS,
  ASPECT_PRESETS,
  DEFAULT_ASPECT_PRESET,
  DEFAULT_RESOLUTION_PRESET,
  loadImageNaturalSize,
  RESOLUTION_PRESET_OPTIONS,
  resolveWanResolution,
  isAspectPreset,
  isResolutionPreset
} from '../utils/wanResolution'
import { splitModelsByHighLow } from '../utils/highLowModelSplit'
import {
  getIncompleteSetupItems,
  type SetupIncompleteItem,
  type SetupSettingsTab
} from '../utils/setupCompleteness'
import { SetupIncompleteDialog } from './SetupIncompleteDialog'
import { useSharedGenerateGallery } from './SharedGenerateGalleryContext'

type Panel = VideoGenPanel

interface Props {
  panel: Panel
  /** False while another tab is shown (view stays mounted so Generate/Abort state survives). */
  active?: boolean
  settings: AppSettings
  sharedComfy: SharedComfyDraft
  draft: I2vGenerateDraft | Flf2vGenerateDraft
  /** Start / loop frame from Prompt tab selection. */
  startImagePath: string
  /** English prompt from Prompt tab. */
  promptText: string
  /** Image list from the Prompt tab folder. */
  promptImages: ImageItem[]
  onSelectStartImage: (imagePath: string) => void
  onSharedComfyChange: (shared: SharedComfyDraft) => void
  onDraftChange: (draft: I2vGenerateDraft | Flf2vGenerateDraft) => void
  /** Switch I2V / FLF2V / LOOP sub-mode inside Video Gen. */
  onPanelChange: (panel: VideoGenPanel) => void
  onStatus: (msg: string, isError?: boolean, options?: { sticky?: boolean }) => void
  /** Open Settings, optionally on a specific incomplete-setup tab. */
  onOpenSettings?: (tab?: SetupSettingsTab | null) => void
  /** True while any generate panel is running a video job (blocks Local AI). */
  videoGenerating?: boolean
  onVideoGeneratingChange?: (generating: boolean) => void
  /** Write generated prompt back to Prompt tab / App settings. */
  onPromptSourceChange?: (imagePath: string, promptText: string) => void
}

const SAMPLERS = [
  'euler',
  'euler_ancestral',
  'heun',
  'dpmpp_2m',
  'dpmpp_2m_sde',
  'uni_pc'
] as const

const SCHEDULERS = [
  'simple',
  'normal',
  'karras',
  'exponential',
  'sgm_uniform',
  'beta'
] as const

function isFlfDraft(d: I2vGenerateDraft | Flf2vGenerateDraft): d is Flf2vGenerateDraft {
  return 'flfMode' in d
}

export function GenerateView({
  panel,
  active = true,
  settings,
  sharedComfy,
  draft,
  startImagePath,
  promptText,
  promptImages,
  onSelectStartImage,
  onSharedComfyChange,
  onDraftChange,
  onPanelChange,
  onStatus,
  onOpenSettings,
  videoGenerating = false,
  onVideoGeneratingChange,
  onPromptSourceChange
}: Props) {
  const { comfyBusy, ensureComfyOnline } = useComfyUi()
  const [generating, setGenerating] = useState(false)
  const [generateElapsedSec, setGenerateElapsedSec] = useState(0)
  const [batchProgress, setBatchProgress] = useState<{ current: number; total: number } | null>(
    null
  )
  const { refreshGallery, setSelectedVideo } = useSharedGenerateGallery()

  const [resolvedSize, setResolvedSize] = useState<{ width: number; height: number }>({
    width: draft.width,
    height: draft.height
  })
  const [ditModels, setDitModels] = useState<{ name: string; path: string }[]>([])
  const [speedLoraModels, setSpeedLoraModels] = useState<{ name: string; path: string }[]>([])
  const [wan22LoraModels, setWan22LoraModels] = useState<{ name: string; path: string }[]>([])
  const [loraPopupOpen, setLoraPopupOpen] = useState(false)
  const [imagePicker, setImagePicker] = useState<null | 'start' | 'end'>(null)
  const [setupIncompleteItems, setSetupIncompleteItems] = useState<SetupIncompleteItem[] | null>(
    null
  )

  const abortRef = useRef<AbortController | null>(null)
  /** Monotonic id so a stale run's `finally` cannot clear a newer run's UI. */
  const generateEpochRef = useRef(0)
  const imagePickerListRef = useRef<HTMLDivElement | null>(null)
  const draftRef = useRef(draft)
  draftRef.current = draft
  const sharedRef = useRef(sharedComfy)
  sharedRef.current = sharedComfy
  const startImageRef = useRef(startImagePath)
  startImageRef.current = startImagePath
  const promptTextRef = useRef(promptText)
  promptTextRef.current = promptText

  const patchDraft = useCallback(
    (partial: Partial<I2vGenerateDraft & Flf2vGenerateDraft>) => {
      onDraftChange({ ...draftRef.current, ...partial } as I2vGenerateDraft | Flf2vGenerateDraft)
    },
    [onDraftChange]
  )

  const promptImagePaths = useMemo(() => promptImages.map((img) => img.path), [promptImages])

  const dismissImagePicker = useCallback(() => setImagePicker(null), [])
  const imagePickerBackdrop = useBackdropDismiss(dismissImagePicker)

  const selectPickerImage = useCallback(
    (path: string) => {
      if (imagePicker === 'end') {
        patchDraft({ endImagePath: path })
      } else {
        onSelectStartImage(path)
      }
    },
    [imagePicker, onSelectStartImage, patchDraft]
  )

  const ignoreWhenOtherModal = useCallback((e: KeyboardEvent) => {
    if (document.querySelector('.settings-modal, .confirm-modal, .setup-incomplete-modal')) {
      return true
    }
    const t = e.target
    if (t instanceof Element && t.closest('.lora-popup-modal')) return true
    return false
  }, [])

  const pickerSelectedId =
    imagePicker === 'end'
      ? (draft as Flf2vGenerateDraft).endImagePath || null
      : startImagePath || draft.selectedImagePath || null

  useArrowListNav({
    enabled: active && Boolean(imagePicker) && promptImagePaths.length > 0,
    items: promptImagePaths,
    selectedId: pickerSelectedId,
    onSelect: selectPickerImage,
    columns: 'auto',
    containerRef: imagePickerListRef,
    shouldIgnore: ignoreWhenOtherModal
  })

  // Keep draft start image + prompt aligned with Prompt tab.
  useEffect(() => {
    const nextImage = startImagePath.trim()
    const nextPrompt = promptText
    const cur = draftRef.current
    if (cur.selectedImagePath === nextImage && cur.prompt === nextPrompt) return
    patchDraft({
      selectedImagePath: nextImage,
      prompt: nextPrompt
    })
  }, [startImagePath, promptText, patchDraft, panel])

  // Preview computed WAN Div32 size from xxxP + aspect / start image.
  useEffect(() => {
    let cancelled = false
    const preset = isResolutionPreset(draft.resolutionPreset)
      ? draft.resolutionPreset
      : DEFAULT_RESOLUTION_PRESET
    const aspectKey = isAspectPreset(draft.aspectPreset)
      ? draft.aspectPreset
      : DEFAULT_ASPECT_PRESET
    const fallback = ASPECT_PRESETS[aspectKey] || ASPECT_PRESETS[DEFAULT_ASPECT_PRESET]

    void (async () => {
      let aspectW = fallback.w
      let aspectH = fallback.h
      if (draft.scaleFromImage && startImagePath.trim()) {
        try {
          const size = await loadImageNaturalSize(startImagePath.trim())
          aspectW = size.width
          aspectH = size.height
        } catch {
          /* keep aspect preset fallback */
        }
      }
      if (cancelled) return
      const next = resolveWanResolution({
        resolutionPreset: preset,
        aspectW,
        aspectH
      })
      setResolvedSize(next)
      if (draftRef.current.width !== next.width || draftRef.current.height !== next.height) {
        patchDraft({ width: next.width, height: next.height })
      }
    })()

    return () => {
      cancelled = true
    }
  }, [
    draft.resolutionPreset,
    draft.scaleFromImage,
    draft.aspectPreset,
    startImagePath,
    patchDraft
  ])

  const patchShared = useCallback(
    (partial: Partial<SharedComfyDraft>) => {
      onSharedComfyChange({ ...sharedRef.current, ...partial })
    },
    [onSharedComfyChange]
  )

  // List DiT models from Settings → DiT model folder.
  useEffect(() => {
    const folder = sharedComfy.ditModelFolder.trim()
    let cancelled = false
    if (!folder) {
      setDitModels([])
      return
    }
    void window.api.listModelFiles(folder).then((files) => {
      if (!cancelled) setDitModels(files)
    })
    return () => {
      cancelled = true
    }
  }, [sharedComfy.ditModelFolder])

  useEffect(() => {
    const folder = sharedComfy.speedLoraFolder.trim()
    let cancelled = false
    if (!folder) {
      setSpeedLoraModels([])
      return
    }
    void window.api.listModelFiles(folder).then((files) => {
      if (!cancelled) setSpeedLoraModels(files)
    })
    return () => {
      cancelled = true
    }
  }, [sharedComfy.speedLoraFolder])

  useEffect(() => {
    const folder = sharedComfy.wan22LoraFolder.trim()
    let cancelled = false
    if (!folder) {
      setWan22LoraModels([])
      return
    }
    void window.api.listModelFiles(folder).then((files) => {
      if (!cancelled) setWan22LoraModels(files)
    })
    return () => {
      cancelled = true
    }
  }, [sharedComfy.wan22LoraFolder])

  const ensureOnlineForGenerate = async (): Promise<boolean> => {
    const s = sharedRef.current
    const d = draftRef.current
    const extraPaths = [
      ...(d.extraLorasHigh || []).map((e) => e.path),
      ...(d.extraLorasLow || []).map((e) => e.path)
    ]
    return ensureComfyOnline({
      ditFolders: uniqueDirs([s.highDitPath, s.lowDitPath], [s.ditModelFolder]),
      vaeFolders: uniqueDirs([s.vaePath]),
      clipFolders: uniqueDirs([s.clipPath]),
      loraFolders: uniqueDirs(
        [d.loraHighPath, d.loraLowPath, ...extraPaths],
        [s.speedLoraFolder, s.wan22LoraFolder]
      ),
      upscaleFolders: uniqueDirs([], [s.upscaleModelFolder]),
      frameInterpFolders: uniqueDirs([], [s.frameInterpModelFolder])
    })
  }

  const abortGenerate = async () => {
    abortRef.current?.abort()
    try {
      await interruptComfyGeneration(COMFY_BASE_URL)
    } catch {
      /* ignore */
    }
    // Keep Abort button until runGenerate's finally clears state — clearing
    // here made Generate clickable while remaining batch items were still running.
    onStatus('Aborting generation…', false, { sticky: true })
  }

  const runGenerate = async () => {
    if (generating) return
    if (videoGenerating) {
      onStatus('Another video generation is already running', true)
      return
    }

    const incomplete = getIncompleteSetupItems(settings)
    if (incomplete.length > 0) {
      setSetupIncompleteItems(incomplete)
      return
    }

    const d = draftRef.current
    const s = sharedRef.current
    const flf = isFlfDraft(d) ? d : null
    const mode =
      panel === 'i2v' ? 'i2v' : flf?.flfMode === 'wanfun_inpaint' ? 'wanfun_inpaint' : 'flf2v'
    const isLoop = panel === 'loop'

    const startPath = startImageRef.current.trim() || d.selectedImagePath.trim()
    let prompt = d.prompt.trim() || promptTextRef.current.trim()
    const endPath = isLoop ? startPath : (flf?.endImagePath || '').trim()
    const batchTotal = Math.min(100, Math.max(1, Math.round(Number(d.batchCount) || 1)))
    const autoAiPrompt = Boolean(d.autoAiPrompt)

    if (!startPath) {
      onStatus(
        isLoop
          ? 'Select a loop frame in the Prompt tab first'
          : 'Select an image in the Prompt tab first',
        true
      )
      return
    }
    if (mode !== 'i2v' && !endPath) {
      onStatus('Select an end frame image for FLF2V / WanFunInpaint', true)
      return
    }
    if (!autoAiPrompt && !prompt) {
      onStatus('Generate or enter a prompt in the Prompt tab first', true)
      return
    }

    const preset = isResolutionPreset(d.resolutionPreset)
      ? d.resolutionPreset
      : DEFAULT_RESOLUTION_PRESET
    const aspectKey = isAspectPreset(d.aspectPreset) ? d.aspectPreset : DEFAULT_ASPECT_PRESET
    const fallbackAspect = ASPECT_PRESETS[aspectKey] || ASPECT_PRESETS[DEFAULT_ASPECT_PRESET]
    let aspectW = fallbackAspect.w
    let aspectH = fallbackAspect.h
    if (d.scaleFromImage) {
      try {
        const size = await loadImageNaturalSize(startPath)
        aspectW = size.width
        aspectH = size.height
      } catch {
        onStatus('Could not read start image size — using aspect preset', true)
      }
    }
    const { width, height } = resolveWanResolution({
      resolutionPreset: preset,
      aspectW,
      aspectH
    })
    patchDraft({ width, height })
    setResolvedSize({ width, height })

    if (!s.highDitPath.trim() || !s.lowDitPath.trim() || !s.vaePath.trim() || !s.clipPath.trim()) {
      onStatus('Set High/Low DiT here, and VAE + CLIP/UMT5 in Settings → ComfyUI', true)
      return
    }
    if (!s.outputFolder.trim()) {
      onStatus('Set Output folder in Settings → ComfyUI', true)
      return
    }
    const speedHighOn = Boolean(d.loraHighEnabled && d.loraHighPath.trim())
    const speedLowOn = Boolean(d.loraLowEnabled && d.loraLowPath.trim())
    const useSpeedLora = speedHighOn || speedLowOn
    const lengthFrames = framesFromSeconds(d.seconds, d.fps)
    const modeLabel =
      panel === 'loop'
        ? mode === 'wanfun_inpaint'
          ? 'LOOP · WanFunInpaint'
          : 'LOOP'
        : mode === 'i2v'
          ? 'I2V'
          : mode === 'flf2v'
            ? 'FLF2V'
            : 'WanFunInpaint'

    const report = (detail: string) => {
      onStatus(detail, false, { sticky: true })
    }

    report(`Checking ComfyUI online (${modeLabel})…`)
    const online = await ensureOnlineForGenerate()
    if (!online) return

    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac
    const runEpoch = ++generateEpochRef.current
    setGenerateElapsedSec(0)
    setBatchProgress({ current: 1, total: batchTotal })
    setGenerating(true)
    const startedAt = Date.now()

    const formatElapsed = (ms: number) => {
      const totalSec = Math.max(0, Math.round(ms / 1000))
      const m = Math.floor(totalSec / 60)
      const s = totalSec % 60
      if (m <= 0) return `${s}s`
      return `${m}m ${s}s`
    }

    const elapsedTimer = window.setInterval(() => {
      setGenerateElapsedSec(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)))
    }, 250)

    try {
      let motionNote = ''
      let imagePositive: string | undefined
      if (autoAiPrompt) {
        try {
          const caption = await window.api.readCaption(startPath)
          motionNote = parseSidecarCaption(caption).motionNote
        } catch {
          motionNote = ''
        }
        if (settings.useImagePrompt) {
          try {
            const meta = await window.api.readImagePositivePrompt(startPath)
            const positive = meta.positive?.trim()
            if (positive) imagePositive = positive
          } catch {
            /* ignore — still generate without embedded prompt */
          }
        }
      } else {
        // Block Local AI for the whole video job when not auto-prompting each batch.
        onVideoGeneratingChange?.(true)
        if (settings.unloadLlmOnGenerate) {
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
            } else {
              report('Local AI: no loaded models (or servers offline)')
            }
          } catch (err) {
            report(
              `Local AI unload skipped: ${err instanceof Error ? err.message : String(err)}`
            )
          }
        }
      }

      report(
        `Prepare ${modeLabel}: ${width}×${height}, ${lengthFrames} frames @ ${d.fps}fps, steps ${d.steps} (refiner ${d.refinerStep})` +
          (batchTotal > 1 ? `, batch ×${batchTotal}` : '')
      )

      report(`Uploading start image… (${basenamePath(startPath)})`)
      const uploadedStart = await window.api.comfyUploadImage({
        imagePath: startPath,
        baseUrl: COMFY_BASE_URL
      })

      let uploadedEnd: { name: string; subfolder?: string } | undefined
      if (mode !== 'i2v' && endPath) {
        if (isLoop && endPath === startPath) {
          report('End frame = start frame (loop) — reusing upload')
          uploadedEnd = uploadedStart
        } else {
          report(`Uploading end image… (${basenamePath(endPath)})`)
          uploadedEnd = await window.api.comfyUploadImage({
            imagePath: endPath,
            baseUrl: COMFY_BASE_URL
          })
        }
      } else {
        report('No end frame required (I2V)')
      }

      const seedsUsed: number[] = []
      let lastSavedPath: string | null = null

      for (let batchIndex = 0; batchIndex < batchTotal; batchIndex++) {
        if (ac.signal.aborted) throw new Error('Generation cancelled')

        setGenerating(true)
        setBatchProgress({ current: batchIndex + 1, total: batchTotal })
        // First run uses draft seed; later runs always random (-1).
        const runSeed = batchIndex === 0 ? d.seed : -1
        const batchTag = batchTotal > 1 ? `[${batchIndex + 1}/${batchTotal}] ` : ''

        if (autoAiPrompt) {
          // Allow Local AI for this batch's prompt (video gate blocks it otherwise).
          onVideoGeneratingChange?.(false)
          report(`${batchTag}Generating AI prompt…`)
          if (ac.signal.aborted) throw new Error('Generation cancelled')
          const generated = await generateI2vPromptForImage(
            settings,
            startPath,
            ac.signal,
            motionNote || undefined,
            imagePositive
          )
          if (ac.signal.aborted) throw new Error('Generation cancelled')
          const nextPrompt = generated.trim()
          if (!nextPrompt) {
            throw new Error('AI prompt generation returned empty text')
          }
          prompt = nextPrompt
          patchDraft({ prompt: nextPrompt })
          onPromptSourceChange?.(startPath, nextPrompt)

          onVideoGeneratingChange?.(true)
          if (settings.unloadLlmOnGenerate) {
            report(`${batchTag}Unloading Local AI models…`)
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
                report(`${batchTag}Local AI unloaded — ${parts.join(' · ')}`)
              }
            } catch (err) {
              report(
                `${batchTag}Local AI unload skipped: ${err instanceof Error ? err.message : String(err)}`
              )
            }
          }
        }

        report(
          `${batchTag}ComfyUI generate: seed ${runSeed < 0 ? 'random' : runSeed}, sampler ${d.sampler}/${d.scheduler}` +
            (useSpeedLora ? ', Speed LoRA on' : '')
        )
        const result = await generateWan22LoopWithComfy(
          {
            mode,
            prompt,
            negative: d.negative,
            steps: d.steps,
            refinerStep: d.refinerStep,
            cfg: d.cfg,
            cfgHigh: d.cfgHigh,
            seed: runSeed,
            width,
            height,
            seconds: d.seconds,
            fps: d.fps,
            shift: d.shift,
            sampler: d.sampler,
            scheduler: d.scheduler,
            highDitName: basenamePath(s.highDitPath),
            lowDitName: basenamePath(s.lowDitPath),
            vaeName: basenamePath(s.vaePath),
            clipName: basenamePath(s.clipPath),
            loraHighName: speedHighOn ? basenamePath(d.loraHighPath) : undefined,
            loraLowName: speedLowOn ? basenamePath(d.loraLowPath) : undefined,
            loraHighStrength: d.loraHighStrength,
            loraLowStrength: d.loraLowStrength,
            useLightningLora: useSpeedLora,
            extraLorasHigh: (d.extraLorasHigh || [])
              .filter((e) => e.enabled !== false && e.path.trim())
              .map((e) => ({
                name: basenamePath(e.path),
                strength: e.strength
              })),
            extraLorasLow: (d.extraLorasLow || [])
              .filter((e) => e.enabled !== false && e.path.trim())
              .map((e) => ({
                name: basenamePath(e.path),
                strength: e.strength
              })),
            uploadedStartImage: uploadedStart.name,
            uploadedStartSubfolder: uploadedStart.subfolder,
            uploadedEndImage: uploadedEnd?.name,
            uploadedEndSubfolder: uploadedEnd?.subfolder,
            savePrefix: isLoop
              ? mode === 'wanfun_inpaint'
                ? 'loop/Wan2.2_loop_inpaint'
                : 'loop/Wan2.2_loop'
              : undefined,
            videoFormat: s.videoFormat,
            videoCodec: s.videoCodec,
            videoBitDepth: s.videoBitDepth,
            videoCrf: s.videoCrf,
            useColorMatch: s.useColorMatch,
            motionAmplitude: d.motionAmplitude,
            noiseStrength: d.noiseStrength
          },
          {
            signal: ac.signal,
            baseUrl: COMFY_BASE_URL,
            onProgress: (msg) => {
              if (ac.signal.aborted) return
              onStatus(`${batchTag}${msg}`, false, { sticky: true })
            }
          }
        )

        if (ac.signal.aborted) throw new Error('Generation cancelled')

        seedsUsed.push(result.seed)
        const videoRef = result.videos[0]
        report(
          `${batchTag}Resolve output… (${videoRef.subfolder ? `${videoRef.subfolder}/` : ''}${videoRef.filename})`
        )
        const resolved = await window.api.comfyResolveImagePath({
          filename: videoRef.filename,
          subfolder: videoRef.subfolder,
          type: videoRef.type
        })
        if (!resolved.ok || !resolved.path) {
          throw new Error(resolved.error || 'Could not resolve ComfyUI video path')
        }

        report(`${batchTag}Save to gallery… → ${s.outputFolder.trim()}`)
        const namePrefix = panel === 'loop' ? 'LOOP' : panel === 'i2v' ? 'I2V' : 'FLF2V'
        const saved = await window.api.gallerySaveVideo({
          sourcePath: resolved.path,
          outputFolder: s.outputFolder.trim(),
          namePrefix,
          seed: result.seed,
          prompt
        })
        if (!saved.ok || !saved.path) {
          throw new Error(saved.error || 'Failed to save video to gallery')
        }
        if (saved.warning) {
          report(`${batchTag}Metadata warning: ${saved.warning}`)
        }
        lastSavedPath = saved.path
        await refreshGallery()
        setSelectedVideo(saved.path)
      }

      const elapsed = formatElapsed(Date.now() - startedAt)
      const seedSummary =
        seedsUsed.length === 1
          ? `seed ${seedsUsed[0]}`
          : `seeds ${seedsUsed.join(', ')}`
      onStatus(
        `Done — ${modeLabel}, ${seedSummary}, ${lengthFrames} frames, ${width}×${height}` +
          (batchTotal > 1 ? `, batch ${batchTotal}` : '') +
          `, ${elapsed}`,
        false,
        { sticky: true }
      )
      if (lastSavedPath) setSelectedVideo(lastSavedPath)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg === 'Generation cancelled') {
        onStatus('Generation cancelled')
        return
      }
      onStatus(msg, true)
    } finally {
      window.clearInterval(elapsedTimer)
      if (generateEpochRef.current === runEpoch) {
        if (abortRef.current === ac) abortRef.current = null
        setGenerating(false)
        setBatchProgress(null)
        setGenerateElapsedSec(0)
        onVideoGeneratingChange?.(false)
      }
    }
  }

  const frameCount = framesFromSeconds(draft.seconds, draft.fps)
  const stepsValue = Math.max(1, Math.round(Number(draft.steps) || 1))
  const refinerValue = Math.min(
    stepsValue,
    Math.max(1, Math.round(Number(draft.refinerStep) || 1))
  )
  const lowStepsValue = Math.max(0, stepsValue - refinerValue)
  const defaults = panel === 'i2v' ? DEFAULT_I2V_GENERATE_DRAFT : DEFAULT_FLF2V_GENERATE_DRAFT
  const flfMode: FlfMode = isFlfDraft(draft) ? draft.flfMode : 'flf2v'
  const endImagePath = isFlfDraft(draft) ? draft.endImagePath : ''

  const numField = (
    label: string,
    key: keyof VideoGenerateParams,
    opts?: { step?: number; min?: number; max?: number }
  ) => (
    <label className="field">
      <span>{label}</span>
      <input
        type="number"
        value={Number(draft[key])}
        step={opts?.step ?? 1}
        min={opts?.min}
        max={opts?.max}
        onChange={(e) => patchDraft({ [key]: Number(e.target.value) })}
      />
    </label>
  )

  const ditModelsBySide = useMemo(() => splitModelsByHighLow(ditModels), [ditModels])
  const speedLoraModelsBySide = useMemo(
    () => splitModelsByHighLow(speedLoraModels),
    [speedLoraModels]
  )

  const ditModelSelect = (label: string, key: 'highDitPath' | 'lowDitPath') => {
    const folder = sharedComfy.ditModelFolder.trim()
    const value = String(sharedComfy[key] ?? '')
    const sideModels = key === 'highDitPath' ? ditModelsBySide.high : ditModelsBySide.low
    const known = sideModels.some((m) => m.path === value)
    const options = [
      ...(!known && value
        ? [{ value, label: `${basenamePath(value)} (not in folder)` }]
        : []),
      ...sideModels.map((m) => ({ value: m.path, label: m.name }))
    ]
    const placeholder = !folder
      ? 'Set DiT model folder in Settings'
      : ditModels.length === 0
        ? 'No models in folder'
        : 'Select DiT model…'
    return (
      <label className="field">
        <span>{label}</span>
        <SearchableSelect
          value={known ? value : value ? value : ''}
          options={options}
          disabled={!folder || ditModels.length === 0}
          placeholder={placeholder}
          onChange={(next) => patchShared({ [key]: next })}
        />
      </label>
    )
  }

  const speedLoraSelect = (
    label: string,
    key: 'loraHighPath' | 'loraLowPath',
    strengthKey: 'loraHighStrength' | 'loraLowStrength',
    enabledKey: 'loraHighEnabled' | 'loraLowEnabled'
  ) => {
    const value = String(draft[key] ?? '')
    const enabled = Boolean(draft[enabledKey])
    const onPick = (nextPath: string) => {
      const otherKey = key === 'loraHighPath' ? 'loraLowPath' : 'loraHighPath'
      const otherEnabledKey =
        enabledKey === 'loraHighEnabled' ? 'loraLowEnabled' : 'loraHighEnabled'
      const otherPath = String(draft[otherKey] ?? '').trim()
      const otherEnabled = Boolean(draft[otherEnabledKey])
      const thisOn = enabled && Boolean(nextPath.trim())
      const otherOn = otherEnabled && Boolean(otherPath)
      const next: Partial<VideoGenerateParams> = {
        [key]: nextPath,
        useLightningLora: thisOn || otherOn
      }
      if (thisOn && otherOn) {
        if (draft.steps === 20) next.steps = 8
        if (draft.cfg === 3.5) next.cfg = 1
        if (draft.cfgHigh === 3.5) next.cfgHigh = 5
      } else if (!thisOn && !otherOn) {
        if (draft.steps === 8 || draft.steps === 4) next.steps = 20
        if (draft.cfg === 1) next.cfg = 3.5
      }
      patchDraft(next)
    }
    const toggleEnabled = () => {
      const nextOn = !enabled
      const otherKey = key === 'loraHighPath' ? 'loraLowPath' : 'loraHighPath'
      const otherEnabledKey =
        enabledKey === 'loraHighEnabled' ? 'loraLowEnabled' : 'loraHighEnabled'
      const otherPath = String(draft[otherKey] ?? '').trim()
      const otherEnabled = Boolean(draft[otherEnabledKey])
      const thisActive = nextOn && Boolean(value.trim())
      const otherActive = otherEnabled && Boolean(otherPath)
      const next: Partial<VideoGenerateParams> = {
        [enabledKey]: nextOn,
        useLightningLora: thisActive || otherActive
      }
      if (thisActive && otherActive) {
        if (draft.steps === 20) next.steps = 8
        if (draft.cfg === 3.5) next.cfg = 1
        if (draft.cfgHigh === 3.5) next.cfgHigh = 5
      } else if (!thisActive && !otherActive) {
        if (draft.steps === 8 || draft.steps === 4) next.steps = 20
        if (draft.cfg === 1) next.cfg = 3.5
      }
      patchDraft(next)
    }
    const sideModels =
      key === 'loraHighPath' ? speedLoraModelsBySide.high : speedLoraModelsBySide.low
    const knownSide = sideModels.some((m) => m.path === value)
    const options = [
      ...(!knownSide && value
        ? [{ value, label: `${basenamePath(value)} (not in folder)` }]
        : []),
      ...sideModels.map((m) => ({ value: m.path, label: m.name }))
    ]
    return (
      <label className="field">
        <span>{label}</span>
        <div className={`generate-speed-lora-row${enabled ? '' : ' is-off'}`}>
          <button
            type="button"
            className={`lora-switch${enabled ? ' is-on' : ''}`}
            role="switch"
            aria-checked={enabled}
            aria-label={`${label} on/off`}
            title={enabled ? 'On' : 'Off'}
            onClick={toggleEnabled}
          >
            <span className="lora-switch-knob" />
          </button>
          <SearchableSelect
            value={knownSide ? value : value ? value : ''}
            options={options}
            emptyLabel="-NONE-"
            placeholder="-NONE-"
            disabled={!enabled}
            onChange={onPick}
          />
          <input
            type="number"
            className="generate-speed-lora-weight"
            value={Number(draft[strengthKey])}
            step={0.05}
            min={0}
            max={5}
            title="Weight"
            disabled={!enabled || !value}
            onChange={(e) => patchDraft({ [strengthKey]: Number(e.target.value) })}
          />
        </div>
      </label>
    )
  }

  const extraLorasHigh = draft.extraLorasHigh || []
  const extraLorasLow = draft.extraLorasLow || []
  const activeHigh = extraLorasHigh.filter((e) => e.enabled !== false && e.path.trim()).length
  const activeLow = extraLorasLow.filter((e) => e.enabled !== false && e.path.trim()).length
  const extraLoraCount = activeHigh + activeLow

  return (
    <>
      <aside className="generate-settings">
          <div
            className="view-switch generate-panel-switch"
            role="tablist"
            aria-label="Video Gen mode"
          >
            <button
              type="button"
              role="tab"
              className={`view-switch-seg${panel === 'i2v' ? ' active' : ''}`}
              aria-selected={panel === 'i2v'}
              onClick={() => onPanelChange('i2v')}
            >
              I2V
            </button>
            <button
              type="button"
              role="tab"
              className={`view-switch-seg${panel === 'flf2v' ? ' active' : ''}`}
              aria-selected={panel === 'flf2v'}
              onClick={() => onPanelChange('flf2v')}
            >
              FLF2V
            </button>
            <button
              type="button"
              role="tab"
              className={`view-switch-seg${panel === 'loop' ? ' active' : ''}`}
              aria-selected={panel === 'loop'}
              onClick={() => onPanelChange('loop')}
            >
              LOOP
            </button>
          </div>
          <div className="generate-settings-scroll">
            <div className="generate-settings-col generate-settings-col-left">
              {panel === 'flf2v' || panel === 'loop' ? (
                <label className="field">
                  <span>Mode</span>
                  <div className="view-switch generate-mode-switch" role="tablist" aria-label="FLF mode">
                    <button
                      type="button"
                      role="tab"
                      className={`view-switch-seg${flfMode === 'flf2v' ? ' active' : ''}`}
                      aria-selected={flfMode === 'flf2v'}
                      onClick={() => patchDraft({ flfMode: 'flf2v' })}
                    >
                      FLF2V
                    </button>
                    <button
                      type="button"
                      role="tab"
                      className={`view-switch-seg${flfMode === 'wanfun_inpaint' ? ' active' : ''}`}
                      aria-selected={flfMode === 'wanfun_inpaint'}
                      onClick={() => patchDraft({ flfMode: 'wanfun_inpaint' })}
                    >
                      WanFunInpaint
                    </button>
                  </div>
                </label>
              ) : null}

              {ditModelSelect('High noise DiT', 'highDitPath')}
              {ditModelSelect('Low noise DiT', 'lowDitPath')}

              {speedLoraSelect(
                'Speed LoRA (high)',
                'loraHighPath',
                'loraHighStrength',
                'loraHighEnabled'
              )}
              {speedLoraSelect(
                'Speed LoRA (low)',
                'loraLowPath',
                'loraLowStrength',
                'loraLowEnabled'
              )}
              {!sharedComfy.speedLoraFolder.trim() ? (
                <p className="field-hint">Set Speed LoRA folder in Settings to list models.</p>
              ) : null}

              <div className="field generate-extra-loras">
                <button
                  type="button"
                  className="generate-lora-manager-btn"
                  onClick={() => setLoraPopupOpen(true)}
                >
                  LoRA Manager
                </button>
                {!sharedComfy.wan22LoraFolder.trim() ? (
                  <p className="field-hint">Set Wan22 LoRA folder in Settings → ComfyUI.</p>
                ) : (
                  <p className="field-hint">
                    {`${extraLoraCount} active · High ${activeHigh} / Low ${activeLow}`}
                  </p>
                )}
              </div>

              <div className="field-row-grid">
                {numField('Seconds', 'seconds', { step: 0.5, min: 0.5, max: 60 })}
                {numField('FPS', 'fps', { min: 1, max: 60 })}
              </div>
              <p className="field-hint">
                Length: {frameCount} frames (round(seconds×fps)+1)
              </p>
              <div className="generate-steps-refiner-row">
                <label className="field generate-steps-field">
                  <span>Steps</span>
                  <input
                    type="number"
                    min={1}
                    max={100}
                    step={1}
                    disabled={generating}
                    value={stepsValue}
                    onChange={(e) => {
                      const steps = Math.min(
                        100,
                        Math.max(1, Math.round(Number(e.target.value)) || 1)
                      )
                      const refinerStep = Math.min(
                        steps,
                        Math.max(1, Math.round(Number(draft.refinerStep) || 1))
                      )
                      patchDraft({ steps, refinerStep })
                    }}
                  />
                </label>
                <label className="field generate-refiner-field">
                  <span>{`high ${refinerValue} / low ${lowStepsValue} steps`}</span>
                  <input
                    type="range"
                    min={1}
                    max={stepsValue}
                    step={1}
                    disabled={generating}
                    value={refinerValue}
                    onChange={(e) => {
                      const n = Math.round(Number(e.target.value))
                      patchDraft({
                        refinerStep: Math.min(stepsValue, Math.max(1, n))
                      })
                    }}
                  />
                </label>
              </div>
              <div className="field-row-grid field-row-grid-3">
                {numField('CFG(high)', 'cfgHigh', { step: 0.1, min: 0, max: 30 })}
                {numField('CFG(low)', 'cfg', { step: 0.1, min: 0, max: 30 })}
                {numField('Shift', 'shift', { step: 0.1, min: 0, max: 20 })}
              </div>
              <div className="field-row-grid">
                {numField('Motion amplitude', 'motionAmplitude', {
                  step: 0.05,
                  min: 1,
                  max: 2
                })}
                {numField('Motion noise', 'noiseStrength', {
                  step: 0.01,
                  min: 0,
                  max: 0.3
                })}
              </div>
              <label className="field">
                <span>Seed (−1 = random)</span>
                <div className="field-row">
                  <input
                    type="number"
                    value={Number(draft.seed)}
                    onChange={(e) => patchDraft({ seed: Number(e.target.value) })}
                  />
                  <button
                    type="button"
                    title="Set seed to −1 (random)"
                    onClick={() => patchDraft({ seed: -1 })}
                  >
                    Random
                  </button>
                </div>
              </label>

              <div className="field-row-grid">
                <label className="field">
                  <span>Sampler</span>
                  <select
                    value={draft.sampler}
                    onChange={(e) => patchDraft({ sampler: e.target.value })}
                  >
                    {SAMPLERS.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                    {!SAMPLERS.includes(draft.sampler as (typeof SAMPLERS)[number]) ? (
                      <option value={draft.sampler}>{draft.sampler}</option>
                    ) : null}
                  </select>
                </label>
                <label className="field">
                  <span>Scheduler</span>
                  <select
                    value={draft.scheduler}
                    onChange={(e) => patchDraft({ scheduler: e.target.value })}
                  >
                    {SCHEDULERS.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                    {!SCHEDULERS.includes(draft.scheduler as (typeof SCHEDULERS)[number]) ? (
                      <option value={draft.scheduler}>{draft.scheduler}</option>
                    ) : null}
                  </select>
                </label>
              </div>
            </div>

            <div className="generate-settings-col generate-settings-col-right">
              <label className="field">
                <span>Resolution</span>
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
              </label>

              <div
                className={`generate-aspect-toggle lora-toggle${draft.scaleFromImage ? ' is-on' : ''}`}
              >
                <span className="lora-toggle-label">Use Image Aspect</span>
                <button
                  type="button"
                  className="lora-switch"
                  role="switch"
                  aria-checked={draft.scaleFromImage}
                  aria-label="Use Image Aspect"
                  onClick={() => patchDraft({ scaleFromImage: !draft.scaleFromImage })}
                >
                  <span className="lora-switch-knob" />
                </button>
              </div>

              {!draft.scaleFromImage ? (
                <label className="field">
                  <span>Aspect</span>
                  <select
                    value={
                      isAspectPreset(draft.aspectPreset)
                        ? draft.aspectPreset
                        : DEFAULT_ASPECT_PRESET
                    }
                    onChange={(e) => patchDraft({ aspectPreset: e.target.value })}
                  >
                    {ASPECT_PRESET_OPTIONS.map((a) => (
                      <option key={a} value={a}>
                        {a}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}

              <p className="field-hint">
                Size: {resolvedSize.width}×{resolvedSize.height} (WAN Div32, like workflow)
              </p>

              <div className="field">
                <span>
                  {panel === 'loop' ? 'Loop frame (Prompt images)' : 'Start frame (Prompt images)'}
                </span>
                {(() => {
                  const selectedPath = startImagePath || draft.selectedImagePath
                  const selected = promptImages.find((img) => img.path === selectedPath)
                  if (promptImages.length === 0) {
                    return (
                      <p className="field-hint">No images — add a folder from the toolbar.</p>
                    )
                  }
                  if (!selected) {
                    return (
                      <button
                        type="button"
                        className="generate-selected-image-btn is-empty"
                        onClick={() => setImagePicker('start')}
                      >
                        Click to choose image
                      </button>
                    )
                  }
                  return (
                    <button
                      type="button"
                      className="generate-selected-image-btn"
                      title={selected.name}
                      onClick={() => setImagePicker('start')}
                    >
                      <img src={window.api.toLocalUrl(selected.path)} alt="" />
                    </button>
                  )
                })()}
                {panel === 'loop' ? (
                  <p className="field-hint">
                    Used as both first and last frame (seamless loop).
                  </p>
                ) : null}
              </div>

              {panel === 'flf2v' ? (
                <div className="field">
                  <span>End frame (Prompt images)</span>
                  {(() => {
                    if (promptImages.length === 0) {
                      return (
                        <p className="field-hint">No images — add a folder from the toolbar.</p>
                      )
                    }
                    const selected = promptImages.find((img) => img.path === endImagePath)
                    if (!selected) {
                      return (
                        <button
                          type="button"
                          className="generate-selected-image-btn is-empty"
                          onClick={() => setImagePicker('end')}
                        >
                          Click to choose end frame
                        </button>
                      )
                    }
                    return (
                      <button
                        type="button"
                        className="generate-selected-image-btn"
                        title={selected.name}
                        onClick={() => setImagePicker('end')}
                      >
                        <img src={window.api.toLocalUrl(selected.path)} alt="" />
                      </button>
                    )
                  })()}
                </div>
              ) : null}

              <div
                className={`generate-aspect-toggle lora-toggle${draft.autoAiPrompt ? ' is-on' : ''}${generating ? ' is-disabled' : ''}`}
              >
                <span className="lora-toggle-label">Auto AI prompt</span>
                <button
                  type="button"
                  className="lora-switch"
                  role="switch"
                  aria-checked={Boolean(draft.autoAiPrompt)}
                  aria-label="Auto AI prompt"
                  disabled={generating}
                  onClick={() => patchDraft({ autoAiPrompt: !draft.autoAiPrompt })}
                >
                  <span className="lora-switch-knob" />
                </button>
              </div>

              <label className="field generate-settings-prompt-field">
                <span>Prompt (from Prompt tab)</span>
                <textarea
                  rows={6}
                  value={draft.prompt}
                  onChange={(e) => patchDraft({ prompt: e.target.value })}
                  spellCheck={false}
                  placeholder="Select an image and generate a prompt in the Prompt tab"
                />
                <p className="field-hint">
                  {draft.autoAiPrompt
                    ? 'Auto AI prompt on: each Generate / batch run creates a new Prompt-tab AI prompt, then video.'
                    : 'Synced from Prompt; edits here apply to this generate only.'}
                </p>
              </label>

              <label className="field generate-settings-negative-field">
                <span>Negative</span>
                <textarea
                  rows={5}
                  value={draft.negative}
                  onChange={(e) => patchDraft({ negative: e.target.value })}
                  spellCheck={false}
                  placeholder={defaults.negative.slice(0, 40) + '…'}
                />
              </label>
            </div>
          </div>

          <div className="generate-actions">
            <label className="generate-batch-field" title="Generate this many times. First uses Seed; later runs use random seed.">
              <span>Batch</span>
              <input
                type="number"
                min={1}
                max={100}
                step={1}
                disabled={generating}
                value={Number(draft.batchCount) || 1}
                onChange={(e) => {
                  const n = Math.round(Number(e.target.value))
                  patchDraft({
                    batchCount: Number.isFinite(n) ? Math.min(100, Math.max(1, n)) : 1
                  })
                }}
              />
            </label>
            {generating ? (
              <button
                type="button"
                className="danger lora-test-generate-btn"
                onClick={() => void abortGenerate()}
              >
                Abort
                {batchProgress && batchProgress.total > 1
                  ? ` · ${batchProgress.current}/${batchProgress.total}`
                  : ''}{' '}
                · {generateElapsedSec} Sec
              </button>
            ) : (
              <button
                type="button"
                className="primary lora-test-generate-btn"
                disabled={comfyBusy || videoGenerating}
                title={
                  videoGenerating ? 'Another panel is generating — Local AI is paused' : undefined
                }
                onClick={() => void runGenerate()}
              >
                Generate
              </button>
            )}
          </div>
      </aside>

      <ExtraLoraDialog
        open={loraPopupOpen}
        models={wan22LoraModels}
        folderSet={Boolean(sharedComfy.wan22LoraFolder.trim())}
        highLoras={extraLorasHigh}
        lowLoras={extraLorasLow}
        onChangeHigh={(extraLorasHigh) => patchDraft({ extraLorasHigh })}
        onChangeLow={(extraLorasLow) => patchDraft({ extraLorasLow })}
        onClose={() => setLoraPopupOpen(false)}
      />

      <SetupIncompleteDialog
        open={Boolean(setupIncompleteItems?.length)}
        items={setupIncompleteItems ?? []}
        onClose={() => setSetupIncompleteItems(null)}
        onOpenSettings={() => {
          const tab = setupIncompleteItems?.[0]?.tab ?? null
          setSetupIncompleteItems(null)
          onOpenSettings?.(tab)
        }}
      />

      {imagePicker ? (
        <div
          className="modal-backdrop"
          role="presentation"
          {...imagePickerBackdrop}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setImagePicker(null)
          }}
        >
          <div
            className="modal modal-wide generate-image-picker-modal"
            role="dialog"
            aria-modal="true"
            aria-label={imagePicker === 'end' ? 'Choose end frame' : 'Choose image'}
          >
            <div className="generate-image-picker-header">
              <h2>
                {imagePicker === 'end'
                  ? 'Choose end frame'
                  : panel === 'loop'
                    ? 'Choose loop frame'
                    : 'Choose start frame'}
              </h2>
              <button type="button" onClick={() => setImagePicker(null)}>
                Close
              </button>
            </div>
            <div
              ref={imagePickerListRef}
              className="generate-prompt-image-list generate-image-picker-grid"
              role="listbox"
            >
              {promptImages.map((img) => {
                const activePath =
                  imagePicker === 'end'
                    ? endImagePath
                    : startImagePath || draft.selectedImagePath
                const active = img.path === activePath
                return (
                  <button
                    key={img.path}
                    type="button"
                    role="option"
                    data-nav-id={img.path}
                    aria-selected={active}
                    className={`generate-prompt-image-item${active ? ' active' : ''}${img.hasCaption ? ' has-caption' : ''}`}
                    title={img.name}
                    onClick={() => {
                      if (imagePicker === 'end') {
                        patchDraft({ endImagePath: img.path })
                      } else {
                        onSelectStartImage(img.path)
                      }
                      setImagePicker(null)
                    }}
                  >
                    <img src={window.api.toLocalUrl(img.path)} alt="" />
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}
