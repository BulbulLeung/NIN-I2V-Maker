import { useEffect, useState } from 'react'
import type {
  AppSettings,
  Flf2vGenerateDraft,
  I2vGenerateDraft,
  ImageItem,
  LoopGenerateDraft,
  SharedComfyDraft,
  VideoGenPanel
} from '../types'
import type { SetupSettingsTab } from '../utils/setupCompleteness'
import { GenerateView } from './GenerateView'
import { GenerateGalleryPane } from './GenerateGalleryPane'
import { ResourceMonitorPane } from './ResourceMonitorPane'

interface Props {
  /** False while Prompt / Upscale is shown (shell stays mounted). */
  active: boolean
  videoGenPanel: VideoGenPanel
  settings: AppSettings
  sharedComfy: SharedComfyDraft
  startImagePath: string
  promptText: string
  promptImages: ImageItem[]
  onSelectStartImage: (imagePath: string) => void
  onSharedComfyChange: (shared: SharedComfyDraft) => void
  onI2vDraftChange: (draft: I2vGenerateDraft) => void
  onFlf2vDraftChange: (draft: Flf2vGenerateDraft) => void
  onLoopDraftChange: (draft: LoopGenerateDraft) => void
  onPanelChange: (panel: VideoGenPanel) => void
  onStatus: (msg: string, isError?: boolean, options?: { sticky?: boolean }) => void
  onOpenSettings?: (tab?: SetupSettingsTab | null) => void
  videoGenerating?: boolean
  onVideoGeneratingChange?: (generating: boolean) => void
  onPromptSourceChange?: (imagePath: string, promptText: string) => void
}

export function VideoGenView({
  active,
  videoGenPanel,
  settings,
  sharedComfy,
  startImagePath,
  promptText,
  promptImages,
  onSelectStartImage,
  onSharedComfyChange,
  onI2vDraftChange,
  onFlf2vDraftChange,
  onLoopDraftChange,
  onPanelChange,
  onStatus,
  onOpenSettings,
  videoGenerating = false,
  onVideoGeneratingChange,
  onPromptSourceChange
}: Props) {
  const [monitorDevice, setMonitorDevice] = useState('cuda:0')

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const devices = await window.api.listGpuDevices()
        if (!cancelled && devices[0]?.id) setMonitorDevice(devices[0].id)
      } catch {
        /* keep default */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const onUseSeed = (seed: number) => {
    if (videoGenPanel === 'i2v') {
      onI2vDraftChange({ ...settings.i2vDraft, seed })
    } else if (videoGenPanel === 'flf2v') {
      onFlf2vDraftChange({ ...settings.flf2vDraft, seed })
    } else {
      onLoopDraftChange({ ...settings.loopDraft, seed })
    }
  }

  const onUsePrompt = (prompt: string) => {
    const text = prompt.trim()
    if (!text) return
    if (videoGenPanel === 'i2v') {
      onI2vDraftChange({ ...settings.i2vDraft, prompt: text })
    } else if (videoGenPanel === 'flf2v') {
      onFlf2vDraftChange({ ...settings.flf2vDraft, prompt: text })
    } else {
      onLoopDraftChange({ ...settings.loopDraft, prompt: text })
    }
    onPromptSourceChange?.(startImagePath.trim() || settings.i2vDraft.selectedImagePath, text)
  }

  return (
    <div className="generate-view">
      <div className="generate-body">
        <div className="generate-settings-host">
          <div
            className="generate-settings-slot"
            style={{ display: videoGenPanel === 'i2v' ? undefined : 'none' }}
            aria-hidden={videoGenPanel !== 'i2v'}
          >
            <GenerateView
              panel="i2v"
              active={active && videoGenPanel === 'i2v'}
              settings={settings}
              sharedComfy={sharedComfy}
              draft={settings.i2vDraft}
              startImagePath={startImagePath}
              promptText={promptText}
              promptImages={promptImages}
              onSelectStartImage={onSelectStartImage}
              onSharedComfyChange={onSharedComfyChange}
              onDraftChange={(d) => onI2vDraftChange(d as I2vGenerateDraft)}
              onPanelChange={onPanelChange}
              onStatus={onStatus}
              onOpenSettings={onOpenSettings}
              videoGenerating={videoGenerating}
              onVideoGeneratingChange={onVideoGeneratingChange}
              onPromptSourceChange={onPromptSourceChange}
            />
          </div>
          <div
            className="generate-settings-slot"
            style={{ display: videoGenPanel === 'flf2v' ? undefined : 'none' }}
            aria-hidden={videoGenPanel !== 'flf2v'}
          >
            <GenerateView
              panel="flf2v"
              active={active && videoGenPanel === 'flf2v'}
              settings={settings}
              sharedComfy={sharedComfy}
              draft={settings.flf2vDraft}
              startImagePath={startImagePath}
              promptText={promptText}
              promptImages={promptImages}
              onSelectStartImage={onSelectStartImage}
              onSharedComfyChange={onSharedComfyChange}
              onDraftChange={(d) => onFlf2vDraftChange(d as Flf2vGenerateDraft)}
              onPanelChange={onPanelChange}
              onStatus={onStatus}
              onOpenSettings={onOpenSettings}
              videoGenerating={videoGenerating}
              onVideoGeneratingChange={onVideoGeneratingChange}
              onPromptSourceChange={onPromptSourceChange}
            />
          </div>
          <div
            className="generate-settings-slot"
            style={{ display: videoGenPanel === 'loop' ? undefined : 'none' }}
            aria-hidden={videoGenPanel !== 'loop'}
          >
            <GenerateView
              panel="loop"
              active={active && videoGenPanel === 'loop'}
              settings={settings}
              sharedComfy={sharedComfy}
              draft={settings.loopDraft}
              startImagePath={startImagePath}
              promptText={promptText}
              promptImages={promptImages}
              onSelectStartImage={onSelectStartImage}
              onSharedComfyChange={onSharedComfyChange}
              onDraftChange={(d) => onLoopDraftChange(d as LoopGenerateDraft)}
              onPanelChange={onPanelChange}
              onStatus={onStatus}
              onOpenSettings={onOpenSettings}
              videoGenerating={videoGenerating}
              onVideoGeneratingChange={onVideoGeneratingChange}
              onPromptSourceChange={onPromptSourceChange}
            />
          </div>
        </div>

        <GenerateGalleryPane
          active={active}
          outputFolder={sharedComfy.outputFolder}
          onUseSeed={onUseSeed}
          onUsePrompt={onUsePrompt}
          onStatus={onStatus}
        />

        <aside className="generate-monitor">
          <ResourceMonitorPane device={monitorDevice} active={active} />
        </aside>
      </div>
    </div>
  )
}
