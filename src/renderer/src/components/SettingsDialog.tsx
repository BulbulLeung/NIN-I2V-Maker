import { useEffect, useMemo, useState } from 'react'
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
  LANGUAGES,
  VIDEO_CRF_MAX,
  VIDEO_CRF_MIN,
  VIDEO_SAVE_BIT_DEPTH_OPTIONS,
  VIDEO_SAVE_CODEC_OPTIONS,
  VIDEO_SAVE_FORMAT_OPTIONS
} from '../types'
import { createDefaultPromptPreset } from '../defaults/i2vPromptPresets'
import { listModels, testConnection } from '../services/translation'
import { DownloadFolderField } from './DownloadFolderField'
import { PythonExecutableField } from './PythonExecutableField'
import { ComfyUiBatField } from './ComfyUiBatField'

interface Props {
  settings: AppSettings
  open: boolean
  onClose: () => void
  onSave: (partial: Partial<AppSettings>) => void
}

type SettingsTab = 'ai' | 'presets' | 'ui' | 'comfy'

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

export function SettingsDialog({ settings, open, onClose, onSave }: Props) {
  const [tab, setTab] = useState<SettingsTab>('ai')
  const [draft, setDraft] = useState(settings)
  const [modelList, setModelList] = useState<string[]>([])
  const [testMsg, setTestMsg] = useState<string | null>(null)
  const [testErr, setTestErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setDraft(settings)
    setTab('ai')
    setModelList([])
    setTestMsg(null)
    setTestErr(null)
  }, [open, settings])

  const activePreset = useMemo(() => {
    return (
      draft.promptPresets.find((p) => p.id === draft.activePromptPresetId) ??
      draft.promptPresets[0] ??
      null
    )
  }, [draft.promptPresets, draft.activePromptPresetId])

  if (!open) return null

  const patch = (partial: Partial<AppSettings>) => {
    setDraft((prev) => ({ ...prev, ...partial }))
  }

  const patchSharedComfy = (partial: Partial<SharedComfyDraft>) => {
    setDraft((prev) => ({
      ...prev,
      sharedComfy: { ...prev.sharedComfy, ...partial }
    }))
  }

  const updatePreset = (id: string, partial: Partial<PromptPreset>) => {
    patch({
      promptPresets: draft.promptPresets.map((p) =>
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
      promptPresets: [...draft.promptPresets, preset],
      activePromptPresetId: preset.id
    })
  }

  const removePreset = (id: string) => {
    let next = draft.promptPresets.filter((p) => p.id !== id)
    if (next.length === 0) next = [createDefaultPromptPreset()]
    const activeId =
      next.some((p) => p.id === draft.activePromptPresetId)
        ? draft.activePromptPresetId
        : next[0].id
    patch({ promptPresets: next, activePromptPresetId: activeId })
  }

  const handleListModels = async () => {
    setBusy(true)
    setTestMsg(null)
    setTestErr(null)
    try {
      const models = await listModels(draft)
      setModelList(models)
      setTestMsg(
        models.length > 0
          ? `Found ${models.length} model(s)`
          : 'Connected, but no models were listed'
      )
      if (models.length > 0 && !draft.model) {
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
      const msg = await testConnection(draft)
      setTestMsg(msg)
    } catch (err) {
      setTestErr(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const handleSave = () => {
    onSave({
      provider: draft.provider,
      lmStudioBaseUrl: draft.lmStudioBaseUrl,
      ollamaBaseUrl: draft.ollamaBaseUrl,
      model: draft.model,
      targetLanguage: draft.targetLanguage,
      promptPresets: draft.promptPresets,
      activePromptPresetId: draft.activePromptPresetId,
      uiGpuMode: draft.uiGpuMode,
      disableUiGpu: draft.uiGpuMode === 'software',
      downloadFolder: draft.downloadFolder,
      pythonPath: draft.pythonPath,
      sharedComfy: {
        ...draft.sharedComfy,
        comfyUiBatPath: draft.sharedComfy.comfyUiBatPath,
        vaePath: draft.sharedComfy.vaePath,
        clipPath: draft.sharedComfy.clipPath,
        outputFolder: draft.sharedComfy.outputFolder
      }
    })
    onClose()
  }

  const gd = draft.sharedComfy

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="modal settings-modal modal-wide"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        <h2 id="settings-title">Settings</h2>

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
            className={`view-switch-seg${tab === 'comfy' ? ' active' : ''}`}
            aria-selected={tab === 'comfy'}
            onClick={() => setTab('comfy')}
          >
            ComfyUI
          </button>
          <button
            type="button"
            role="tab"
            className={`view-switch-seg${tab === 'ui' ? ' active' : ''}`}
            aria-selected={tab === 'ui'}
            onClick={() => setTab('ui')}
          >
            UI &amp; paths
          </button>
        </div>

        <div className="settings-tab-body">
          {tab === 'ai' && (
            <>
              <label className="field">
                <span>Provider</span>
                <select
                  value={draft.provider}
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

              {draft.provider === 'lmstudio' ? (
                <label className="field">
                  <span>LM Studio base URL</span>
                  <input
                    type="text"
                    value={draft.lmStudioBaseUrl}
                    onChange={(e) => patch({ lmStudioBaseUrl: e.target.value })}
                    spellCheck={false}
                  />
                </label>
              ) : (
                <label className="field">
                  <span>Ollama base URL</span>
                  <input
                    type="text"
                    value={draft.ollamaBaseUrl}
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
                      value={draft.model}
                      onChange={(e) => patch({ model: e.target.value })}
                    >
                      {!modelList.includes(draft.model) && draft.model ? (
                        <option value={draft.model}>{draft.model}</option>
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
                      value={draft.model}
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

              <label className="field">
                <span>Target language (translation)</span>
                <select
                  value={draft.targetLanguage}
                  onChange={(e) => patch({ targetLanguage: e.target.value })}
                >
                  {LANGUAGES.map((lang) => (
                    <option key={lang.code} value={lang.code}>
                      {lang.label}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}

          {tab === 'presets' && (
            <>
              <label className="field">
                <span>Active preset</span>
                <div className="model-row">
                  <select
                    value={draft.activePromptPresetId}
                    onChange={(e) => patch({ activePromptPresetId: e.target.value })}
                  >
                    {draft.promptPresets.map((p) => (
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
                    disabled={draft.promptPresets.length <= 1}
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

          {tab === 'comfy' && (
            <>
              <ComfyUiBatField
                value={gd.comfyUiBatPath}
                onChange={(comfyUiBatPath) => patchSharedComfy({ comfyUiBatPath })}
                downloadFolder={draft.downloadFolder}
                pythonPath={draft.pythonPath}
              />

              <label className="field">
                <span>DiT model folder</span>
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
                </div>
                <p className="field-hint">
                  I2V / FLF2V / LOOP High and Low DiT dropdowns list models from this folder.
                </p>
              </label>

              <label className="field">
                <span>Speed LoRA folder</span>
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
                </div>
                <p className="field-hint">
                  Generate panels pick Speed LoRA (high / low) from this folder.
                </p>
              </label>

              <label className="field">
                <span>Wan22 LoRA folder</span>
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
                </div>
                <p className="field-hint">
                  Extra LoRAs on the generate panels are chosen from this folder.
                </p>
              </label>

              <label className="field">
                <span>VAE</span>
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
                </div>
              </label>

              <label className="field">
                <span>CLIP / UMT5</span>
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
                </div>
              </label>

              <label className="field">
                <span>Output folder</span>
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
                <p className="field-hint">
                  Finished Wan2.2 videos are copied here and shown in the I2V / FLF2V / LOOP gallery.
                </p>
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
                  <span>Compression (CRF) · {gd.videoCrf}</span>
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
              <p className="field-hint">
                Encoded directly by the NIN ComfyUI custom node (H264 / H265 / AV1 / VP9 / ProRes) —
                not converted from H264. Lower CRF = higher quality / larger file. Ignored for ProRes.
                Restart ComfyUI (Stop → Start) after updating the app so the custom node loads.
              </p>

              <div
                className={`generate-aspect-toggle lora-toggle${gd.useSageAttention ? ' is-on' : ''}`}
              >
                <span className="lora-toggle-label">Use SageAttention</span>
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
              <p className="field-hint">
                Starts ComfyUI with <code>--use-sage-attention</code> for faster sampling. Requires
                sageattention in the Python env (see UI tab). Changing this restarts ComfyUI on next
                Start / Generate.
              </p>
            </>
          )}

          {tab === 'ui' && (
            <>
              <label className="field">
                <span>UI GPU mode</span>
                <select
                  value={draft.uiGpuMode}
                  onChange={(e) =>
                    patch({ uiGpuMode: e.target.value as UiGpuMode })
                  }
                >
                  <option value="auto">Auto</option>
                  <option value="onboard">Force onboard / discrete</option>
                  <option value="software">Software (CPU) rendering</option>
                </select>
                <p className="field-hint">
                  Changing UI GPU mode requires restarting the app to take effect.
                </p>
              </label>

              <DownloadFolderField
                value={draft.downloadFolder}
                onChange={(downloadFolder) => patch({ downloadFolder })}
              />

              <PythonExecutableField
                value={draft.pythonPath}
                onChange={(pythonPath) => patch({ pythonPath })}
                downloadFolder={draft.downloadFolder}
                enabled={open}
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

        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <span className="spacer" />
          <button type="button" className="primary" onClick={handleSave}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
