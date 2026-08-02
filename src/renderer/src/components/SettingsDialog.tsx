import { useEffect, useMemo, useState } from 'react'
import { useBackdropDismiss } from '../hooks/useBackdropDismiss'
import type {
  AppSettings,
  PromptPreset,
  SharedComfyDraft,
  UiGpuMode,
  VideoSaveBitDepth,
  VideoSaveCodec,
  VideoSaveFormat
} from '../types'
import {
  VIDEO_CRF_MAX,
  VIDEO_CRF_MIN,
  VIDEO_SAVE_BIT_DEPTH_OPTIONS,
  VIDEO_SAVE_CODEC_OPTIONS,
  VIDEO_SAVE_FORMAT_OPTIONS
} from '../types'
import { createDefaultPromptPreset } from '../defaults/i2vPromptPresets'
import { listModels, testConnection } from '../services/translation'
import {
  isSetupItemIncomplete,
  tabHasIncompleteSetup
} from '../utils/setupCompleteness'
import { DownloadFolderField } from './DownloadFolderField'
import { PythonExecutableField } from './PythonExecutableField'
import { ComfyUiBatField } from './ComfyUiBatField'
import { FieldHintIcon } from './FieldHintIcon'
import {
  ModelPackDownloadButton,
  type ModelPackId
} from './ModelPackDownloadButton'

export type SettingsTab = 'ai' | 'presets' | 'ui' | 'comfy' | 'wan22'

interface Props {
  settings: AppSettings
  open: boolean
  /** When set, open on this tab instead of Local AI. */
  initialTab?: SettingsTab | null
  onClose: () => void
  onSave: (partial: Partial<AppSettings>) => void
}

function SetupDot() {
  return <span className="setup-required-dot" aria-hidden="true" />
}

function newPresetId(): string {
  return `preset-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

async function browseSafetensors(title: string): Promise<string | null> {
  return window.api.openFile({
    title,
    filters: [
      { name: 'Safetensors / Models', extensions: ['safetensors', 'ckpt', 'pt', 'pth', 'bin'] },
      { name: 'All files', extensions: ['*'] }
    ]
  })
}

export function SettingsDialog({ settings, open, initialTab, onClose, onSave }: Props) {
  const [tab, setTab] = useState<SettingsTab>('ai')
  const [modelList, setModelList] = useState<string[]>([])
  const [testMsg, setTestMsg] = useState<string | null>(null)
  const [testErr, setTestErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [busyPackId, setBusyPackId] = useState<ModelPackId | null>(null)
  const [packProgress, setPackProgress] = useState<{
    packId: ModelPackId
    message: string
    pct: number
  } | null>(null)

  useEffect(() => {
    if (!open) return
    setTab(initialTab ?? 'ai')
    setModelList([])
    setTestMsg(null)
    setTestErr(null)
    setBusyPackId(null)
    setPackProgress(null)
  }, [open, initialTab])

  const activePreset = useMemo(() => {
    return (
      settings.promptPresets.find((p) => p.id === settings.activePromptPresetId) ??
      settings.promptPresets[0] ??
      null
    )
  }, [settings.promptPresets, settings.activePromptPresetId])

  const backdrop = useBackdropDismiss(onClose)

  if (!open) return null

  const setupDraft = {
    pythonPath: settings.pythonPath,
    sharedComfy: settings.sharedComfy
  }
  const wan22Incomplete = tabHasIncompleteSetup(setupDraft, 'wan22')
  const comfyIncomplete = tabHasIncompleteSetup(setupDraft, 'comfy')
  const uiIncomplete = tabHasIncompleteSetup(setupDraft, 'ui')

  const patch = (partial: Partial<AppSettings>) => {
    if (partial.uiGpuMode !== undefined) {
      onSave({ ...partial, disableUiGpu: partial.uiGpuMode === 'software' })
      return
    }
    onSave(partial)
  }

  const patchSharedComfy = (partial: Partial<SharedComfyDraft>) => {
    onSave({ sharedComfy: { ...settings.sharedComfy, ...partial } })
  }

  const updatePreset = (id: string, partial: Partial<PromptPreset>) => {
    patch({
      promptPresets: settings.promptPresets.map((p) =>
        p.id === id ? { ...p, ...partial } : p
      )
    })
  }

  const addPreset = () => {
    const preset: PromptPreset = {
      id: newPresetId(),
      name: 'New preset',
      prompt: ''
    }
    patch({
      promptPresets: [...settings.promptPresets, preset],
      activePromptPresetId: preset.id
    })
  }

  const removePreset = (id: string) => {
    let next = settings.promptPresets.filter((p) => p.id !== id)
    if (next.length === 0) next = [createDefaultPromptPreset()]
    const activeId =
      next.some((p) => p.id === settings.activePromptPresetId)
        ? settings.activePromptPresetId
        : next[0].id
    patch({ promptPresets: next, activePromptPresetId: activeId })
  }

  const handleListModels = async () => {
    setBusy(true)
    setTestMsg(null)
    setTestErr(null)
    try {
      const models = await listModels(settings)
      setModelList(models)
      setTestMsg(
        models.length > 0
          ? `Found ${models.length} model(s)`
          : 'Connected, but no models were listed'
      )
      if (models.length > 0 && !settings.model) {
        patch({ model: models[0] })
      }
    } catch (err) {
      setTestErr(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const handleTest = async () => {
    setBusy(true)
    setTestMsg(null)
    setTestErr(null)
    try {
      const msg = await testConnection(settings)
      setTestMsg(msg)
    } catch (err) {
      setTestErr(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const gd = settings.sharedComfy

  const packDownloadProps = (packId: ModelPackId) => ({
    packId,
    downloadFolder: settings.downloadFolder,
    busyPackId,
    onBusyChange: setBusyPackId,
    onProgress: (id: ModelPackId, message: string, pct: number) => {
      setPackProgress({ packId: id, message, pct })
    },
    onError: (message: string) => {
      setTestErr(message)
      setPackProgress(null)
    }
  })

  const packProgressHint = (packId: ModelPackId) =>
    busyPackId === packId && packProgress?.packId === packId ? (
      <p className="field-hint">
        {packProgress.pct > 0 ? `${packProgress.pct}% — ` : ''}
        {packProgress.message}
      </p>
    ) : null

  return (
    <div className="modal-backdrop" role="presentation" {...backdrop}>
      <div
        className="modal settings-modal modal-wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        <div className="settings-modal-header">
          <h2 id="settings-title">Settings</h2>
          <button type="button" className="settings-modal-close" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="view-switch settings-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            className={`view-switch-seg${tab === 'ai' ? ' active' : ''}`}
            aria-selected={tab === 'ai'}
            onClick={() => setTab('ai')}
          >
            Local AI
          </button>
          <button
            type="button"
            role="tab"
            className={`view-switch-seg${tab === 'presets' ? ' active' : ''}`}
            aria-selected={tab === 'presets'}
            onClick={() => setTab('presets')}
          >
            Prompt presets
          </button>
          <button
            type="button"
            role="tab"
            className={`view-switch-seg${tab === 'wan22' ? ' active' : ''}`}
            aria-selected={tab === 'wan22'}
            onClick={() => setTab('wan22')}
          >
            {wan22Incomplete && <SetupDot />}
            Wan2.2 model
          </button>
          <button
            type="button"
            role="tab"
            className={`view-switch-seg${tab === 'comfy' ? ' active' : ''}`}
            aria-selected={tab === 'comfy'}
            onClick={() => setTab('comfy')}
          >
            {comfyIncomplete && <SetupDot />}
            ComfyUI
          </button>
          <button
            type="button"
            role="tab"
            className={`view-switch-seg${tab === 'ui' ? ' active' : ''}`}
            aria-selected={tab === 'ui'}
            onClick={() => setTab('ui')}
          >
            {uiIncomplete && <SetupDot />}
            UI &amp; paths
          </button>
        </div>

        <div className="settings-tab-body">
          {tab === 'ai' && (
            <>
              <label className="field">
                <span>Provider</span>
                <select
                  value={settings.provider}
                  onChange={(e) =>
                    patch({
                      provider: e.target.value === 'ollama' ? 'ollama' : 'lmstudio'
                    })
                  }
                >
                  <option value="lmstudio">LM Studio</option>
                  <option value="ollama">Ollama</option>
                </select>
              </label>

              {settings.provider === 'lmstudio' ? (
                <label className="field">
                  <span>LM Studio base URL</span>
                  <input
                    type="text"
                    value={settings.lmStudioBaseUrl}
                    onChange={(e) => patch({ lmStudioBaseUrl: e.target.value })}
                    spellCheck={false}
                  />
                </label>
              ) : (
                <label className="field">
                  <span>Ollama base URL</span>
                  <input
                    type="text"
                    value={settings.ollamaBaseUrl}
                    onChange={(e) => patch({ ollamaBaseUrl: e.target.value })}
                    spellCheck={false}
                  />
                </label>
              )}

              <label className="field">
                <span>Model</span>
                <div className="model-row">
                  {modelList.length > 0 ? (
                    <select
                      value={settings.model}
                      onChange={(e) => patch({ model: e.target.value })}
                    >
                      {!modelList.includes(settings.model) && settings.model ? (
                        <option value={settings.model}>{settings.model}</option>
                      ) : null}
                      {modelList.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="text"
                      value={settings.model}
                      onChange={(e) => patch({ model: e.target.value })}
                      placeholder="vision / chat model name"
                      spellCheck={false}
                    />
                  )}
                  <button type="button" disabled={busy} onClick={() => void handleListModels()}>
                    List models
                  </button>
                  <button type="button" disabled={busy} onClick={() => void handleTest()}>
                    Test
                  </button>
                </div>
              </label>
            </>
          )}

          {tab === 'presets' && (
            <>
              <label className="field">
                <span>Active preset</span>
                <div className="model-row">
                  <select
                    value={settings.activePromptPresetId}
                    onChange={(e) => patch({ activePromptPresetId: e.target.value })}
                  >
                    {settings.promptPresets.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  <button type="button" onClick={addPreset}>
                    Add
                  </button>
                  <button
                    type="button"
                    className="danger"
                    disabled={settings.promptPresets.length <= 1}
                    onClick={() => activePreset && removePreset(activePreset.id)}
                  >
                    Remove
                  </button>
                </div>
              </label>

              {activePreset ? (
                <>
                  <label className="field">
                    <span>Preset name</span>
                    <input
                      type="text"
                      value={activePreset.name}
                      onChange={(e) => updatePreset(activePreset.id, { name: e.target.value })}
                    />
                  </label>
                  <label className="field">
                    <span>System / vision prompt</span>
                    <textarea
                      className="prompt-textarea"
                      value={activePreset.prompt}
                      onChange={(e) =>
                        updatePreset(activePreset.id, { prompt: e.target.value })
                      }
                      rows={14}
                      spellCheck={false}
                    />
                  </label>
                </>
              ) : null}
            </>
          )}

          {tab === 'wan22' && (
            <>
              <label className="field">
                <span>
                  {isSetupItemIncomplete(setupDraft, 'ditModelFolder') && <SetupDot />}
                  DiT model folder
                  <FieldHintIcon title="DiT model folder">
                    Set the Wan2.2 folder that contains checkpoints.
                    <br />
                    e.g. <code>{'{your comfyui folder}\\models\\diffusion_models\\Wan'}</code>
                  </FieldHintIcon>
                </span>
                <div className="field-row">
                  <input
                    type="text"
                    value={gd.ditModelFolder}
                    onChange={(e) => patchSharedComfy({ ditModelFolder: e.target.value })}
                    spellCheck={false}
                    placeholder="Folder with Wan high/low DiT models"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      void window.api.openFolder().then((dir) => {
                        if (dir) patchSharedComfy({ ditModelFolder: dir })
                      })
                    }}
                  >
                    Browse
                  </button>
                  <ModelPackDownloadButton
                    {...packDownloadProps('dit')}
                    visible={!gd.ditModelFolder.trim()}
                    onDone={(path) => {
                      patchSharedComfy({ ditModelFolder: path })
                      setPackProgress(null)
                      setTestErr(null)
                    }}
                  />
                </div>
                {packProgressHint('dit')}
              </label>

              <label className="field">
                <span>
                  {isSetupItemIncomplete(setupDraft, 'speedLoraFolder') && <SetupDot />}
                  Speed LoRA folder
                  <FieldHintIcon title="Speed LoRA folder">
                    Set the folder that contains Speed LoRA (lightx2v) models.
                    <br />
                    e.g. <code>{'{your comfyui folder}\\models\\loras\\Speed'}</code>
                  </FieldHintIcon>
                </span>
                <div className="field-row">
                  <input
                    type="text"
                    value={gd.speedLoraFolder}
                    onChange={(e) => patchSharedComfy({ speedLoraFolder: e.target.value })}
                    spellCheck={false}
                    placeholder="Folder with high/low Speed (lightx2v) LoRAs"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      void window.api.openFolder().then((dir) => {
                        if (dir) patchSharedComfy({ speedLoraFolder: dir })
                      })
                    }}
                  >
                    Browse
                  </button>
                  <ModelPackDownloadButton
                    {...packDownloadProps('speedLora')}
                    visible={!gd.speedLoraFolder.trim()}
                    onDone={(path) => {
                      patchSharedComfy({ speedLoraFolder: path })
                      setPackProgress(null)
                      setTestErr(null)
                    }}
                  />
                </div>
                {packProgressHint('speedLora')}
              </label>

              <label className="field">
                <span>
                  {isSetupItemIncomplete(setupDraft, 'wan22LoraFolder') && <SetupDot />}
                  Wan22 LoRA folder
                  <FieldHintIcon title="Wan22 LoRA folder">
                    Set the Wan2.2 folder that contains extra LoRA models.
                    <br />
                    e.g. <code>{'{your comfyui folder}\\models\\loras\\Wan'}</code>
                  </FieldHintIcon>
                </span>
                <div className="field-row">
                  <input
                    type="text"
                    value={gd.wan22LoraFolder}
                    onChange={(e) => patchSharedComfy({ wan22LoraFolder: e.target.value })}
                    spellCheck={false}
                    placeholder="Folder with extra Wan2.2 LoRAs"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      void window.api.openFolder().then((dir) => {
                        if (dir) patchSharedComfy({ wan22LoraFolder: dir })
                      })
                    }}
                  >
                    Browse
                  </button>
                  <ModelPackDownloadButton
                    {...packDownloadProps('wan22Lora')}
                    visible={!gd.wan22LoraFolder.trim()}
                    label="Create empty folder"
                    onDone={(path) => {
                      patchSharedComfy({ wan22LoraFolder: path })
                      setPackProgress(null)
                      setTestErr(null)
                    }}
                  />
                </div>
                {packProgressHint('wan22Lora')}
              </label>

              <label className="field">
                <span>
                  {isSetupItemIncomplete(setupDraft, 'upscaleModelFolder') && <SetupDot />}
                  Upscale model folder
                  <FieldHintIcon title="Upscale model folder">
                    Set the folder that contains upscale model weights.
                    <br />
                    e.g.{' '}
                    <code>{'{your comfyui folder}\\models\\upscale_models'}</code>
                  </FieldHintIcon>
                </span>
                <div className="field-row">
                  <input
                    type="text"
                    value={gd.upscaleModelFolder}
                    onChange={(e) => patchSharedComfy({ upscaleModelFolder: e.target.value })}
                    spellCheck={false}
                    placeholder="Folder with UpscaleModelLoader weights"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      void window.api.openFolder().then((dir) => {
                        if (dir) patchSharedComfy({ upscaleModelFolder: dir })
                      })
                    }}
                  >
                    Browse
                  </button>
                  <ModelPackDownloadButton
                    {...packDownloadProps('upscale')}
                    visible={!gd.upscaleModelFolder.trim()}
                    onDone={(path) => {
                      patchSharedComfy({ upscaleModelFolder: path })
                      setPackProgress(null)
                      setTestErr(null)
                    }}
                  />
                </div>
                {packProgressHint('upscale')}
              </label>

              <label className="field">
                <span>
                  {isSetupItemIncomplete(setupDraft, 'frameInterpModelFolder') && <SetupDot />}
                  Frame Interpolation model folder
                  <FieldHintIcon title="Frame Interpolation model folder">
                    Set the folder that contains frame interpolation models.
                    <br />
                    e.g.{' '}
                    <code>{'{your comfyui folder}\\models\\frame_interpolation'}</code>
                  </FieldHintIcon>
                </span>
                <div className="field-row">
                  <input
                    type="text"
                    value={gd.frameInterpModelFolder}
                    onChange={(e) => patchSharedComfy({ frameInterpModelFolder: e.target.value })}
                    spellCheck={false}
                    placeholder="Folder with FrameInterpolationModelLoader weights"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      void window.api.openFolder().then((dir) => {
                        if (dir) patchSharedComfy({ frameInterpModelFolder: dir })
                      })
                    }}
                  >
                    Browse
                  </button>
                  <ModelPackDownloadButton
                    {...packDownloadProps('frameInterp')}
                    visible={!gd.frameInterpModelFolder.trim()}
                    onDone={(path) => {
                      patchSharedComfy({ frameInterpModelFolder: path })
                      setPackProgress(null)
                      setTestErr(null)
                    }}
                  />
                </div>
                {packProgressHint('frameInterp')}
              </label>

              <label className="field">
                <span>
                  {isSetupItemIncomplete(setupDraft, 'vaePath') && <SetupDot />}
                  VAE
                  <FieldHintIcon title="VAE">
                    Set the Wan2.2 VAE checkpoint file.
                    <br />
                    e.g.{' '}
                    <code>
                      {'{your comfyui folder}\\models\\vae\\wan_2.1_vae.safetensors'}
                    </code>
                  </FieldHintIcon>
                </span>
                <div className="field-row">
                  <input
                    type="text"
                    value={gd.vaePath}
                    onChange={(e) => patchSharedComfy({ vaePath: e.target.value })}
                    spellCheck={false}
                    placeholder="wan_2.1_vae.safetensors"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      void browseSafetensors('Select VAE').then((p) => {
                        if (p) patchSharedComfy({ vaePath: p })
                      })
                    }}
                  >
                    Browse
                  </button>
                  <ModelPackDownloadButton
                    {...packDownloadProps('vae')}
                    visible={!gd.vaePath.trim()}
                    onDone={(path) => {
                      patchSharedComfy({ vaePath: path })
                      setPackProgress(null)
                      setTestErr(null)
                    }}
                  />
                </div>
                {packProgressHint('vae')}
              </label>

              <label className="field">
                <span>
                  {isSetupItemIncomplete(setupDraft, 'clipPath') && <SetupDot />}
                  CLIP / UMT5
                  <FieldHintIcon title="CLIP / UMT5">
                    Set the Wan2.2 CLIP / UMT5 text encoder file.
                    <br />
                    e.g.{' '}
                    <code>
                      {
                        '{your comfyui folder}\\models\\text_encoders\\umt5_xxl_fp8_e4m3fn_scaled.safetensors'
                      }
                    </code>
                  </FieldHintIcon>
                </span>
                <div className="field-row">
                  <input
                    type="text"
                    value={gd.clipPath}
                    onChange={(e) => patchSharedComfy({ clipPath: e.target.value })}
                    spellCheck={false}
                    placeholder="umt5_xxl_fp8_e4m3fn_scaled.safetensors"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      void browseSafetensors('Select CLIP / UMT5').then((p) => {
                        if (p) patchSharedComfy({ clipPath: p })
                      })
                    }}
                  >
                    Browse
                  </button>
                  <ModelPackDownloadButton
                    {...packDownloadProps('clip')}
                    visible={!gd.clipPath.trim()}
                    onDone={(path) => {
                      patchSharedComfy({ clipPath: path })
                      setPackProgress(null)
                      setTestErr(null)
                    }}
                  />
                </div>
                {packProgressHint('clip')}
              </label>
            </>
          )}

          {tab === 'comfy' && (
            <>
              <ComfyUiBatField
                value={gd.comfyUiBatPath}
                onChange={(comfyUiBatPath) => patchSharedComfy({ comfyUiBatPath })}
                downloadFolder={settings.downloadFolder}
                pythonPath={settings.pythonPath}
                enabled={open}
                showRequiredDot={isSetupItemIncomplete(setupDraft, 'comfyUiBatPath')}
              />

              <label className="field">
                <span>
                  Output folder
                  <FieldHintIcon title="Output folder">
                    Finished Wan2.2 videos are copied here and shown in the Video Gen gallery.
                  </FieldHintIcon>
                </span>
                <div className="field-row">
                  <input
                    type="text"
                    value={gd.outputFolder}
                    onChange={(e) => patchSharedComfy({ outputFolder: e.target.value })}
                    spellCheck={false}
                    placeholder="Folder for generated MP4 videos"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      void window.api.openFolder().then((dir) => {
                        if (dir) patchSharedComfy({ outputFolder: dir })
                      })
                    }}
                  >
                    Browse
                  </button>
                </div>
              </label>

              <div className="field-row-grid">
                <label className="field">
                  <span>Video format</span>
                  <select
                    value={gd.videoFormat}
                    onChange={(e) =>
                      patchSharedComfy({ videoFormat: e.target.value as VideoSaveFormat })
                    }
                  >
                    {VIDEO_SAVE_FORMAT_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Video codec</span>
                  <select
                    value={gd.videoCodec}
                    onChange={(e) =>
                      patchSharedComfy({ videoCodec: e.target.value as VideoSaveCodec })
                    }
                  >
                    {VIDEO_SAVE_CODEC_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="field-row-grid">
                <label className="field">
                  <span>Bit depth</span>
                  <select
                    value={gd.videoBitDepth}
                    onChange={(e) =>
                      patchSharedComfy({
                        videoBitDepth: Number(e.target.value) as VideoSaveBitDepth
                      })
                    }
                  >
                    {VIDEO_SAVE_BIT_DEPTH_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>
                    Compression (CRF) · {gd.videoCrf}
                    <FieldHintIcon title="Compression (CRF)">
                      Lower CRF = higher quality / larger file. Ignored for ProRes.
                    </FieldHintIcon>
                  </span>
                  <input
                    type="range"
                    min={VIDEO_CRF_MIN}
                    max={VIDEO_CRF_MAX}
                    step={1}
                    value={gd.videoCrf}
                    disabled={gd.videoCodec === 'prores'}
                    onChange={(e) => patchSharedComfy({ videoCrf: Number(e.target.value) })}
                  />
                </label>
              </div>

              <div
                className={`generate-aspect-toggle lora-toggle${gd.useSageAttention ? ' is-on' : ''}`}
              >
                <span className="lora-toggle-label">
                  Use SageAttention
                  <FieldHintIcon title="Use SageAttention">
                    Starts ComfyUI with <code>--use-sage-attention</code> for faster sampling.
                    Requires sageattention in the Python env (see UI tab). Changing this restarts
                    ComfyUI on next Start / Generate.
                  </FieldHintIcon>
                </span>
                <button
                  type="button"
                  className="lora-switch"
                  role="switch"
                  aria-checked={gd.useSageAttention}
                  aria-label="Use SageAttention"
                  onClick={() =>
                    patchSharedComfy({ useSageAttention: !gd.useSageAttention })
                  }
                >
                  <span className="lora-switch-knob" />
                </button>
              </div>

              <div
                className={`generate-aspect-toggle lora-toggle${gd.useColorMatch ? ' is-on' : ''}`}
              >
                <span className="lora-toggle-label">
                  Color Match
                  <FieldHintIcon title="Color Match">
                    After VAE decode, match each frame&apos;s colors to the start image (Reinhard
                    LAB). Reduces color shift between the source still and the generated video.
                    Restart ComfyUI (Stop → Start) after updating the app so the Color Match custom
                    node loads.
                  </FieldHintIcon>
                </span>
                <button
                  type="button"
                  className="lora-switch"
                  role="switch"
                  aria-checked={gd.useColorMatch}
                  aria-label="Color Match"
                  onClick={() => patchSharedComfy({ useColorMatch: !gd.useColorMatch })}
                >
                  <span className="lora-switch-knob" />
                </button>
              </div>
            </>
          )}

          {tab === 'ui' && (
            <>
              <label className="field">
                <span>
                  UI GPU mode
                  <FieldHintIcon title="UI GPU mode">
                    Changing UI GPU mode requires restarting the app to take effect.
                  </FieldHintIcon>
                </span>
                <select
                  value={settings.uiGpuMode}
                  onChange={(e) =>
                    patch({ uiGpuMode: e.target.value as UiGpuMode })
                  }
                >
                  <option value="auto">Auto</option>
                  <option value="onboard">Force onboard / discrete</option>
                  <option value="software">Software (CPU) rendering</option>
                </select>
              </label>

              <DownloadFolderField
                value={settings.downloadFolder}
                onChange={(downloadFolder) => patch({ downloadFolder })}
              />

              <PythonExecutableField
                value={settings.pythonPath}
                onChange={(pythonPath) => patch({ pythonPath })}
                downloadFolder={settings.downloadFolder}
                enabled={open}
                showRequiredDot={isSetupItemIncomplete(setupDraft, 'pythonPath')}
                hint={
                  <>
                    Wan2.2 stack: <code>torch</code> + Windows <code>triton</code> +{' '}
                    <code>sageattention&gt;=2</code>. Leave empty to use <code>python</code> from
                    PATH.
                  </>
                }
              />
            </>
          )}
        </div>

        {testMsg ? <p className="test-ok">{testMsg}</p> : null}
        {testErr ? <p className="test-err">{testErr}</p> : null}
      </div>
    </div>
  )
}
