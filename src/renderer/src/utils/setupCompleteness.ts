import type { AppSettings, SharedComfyDraft } from '../types'

/** Settings tabs that can contain required setup fields. */
export type SetupSettingsTab = 'wan22' | 'comfy' | 'ui'

export interface SetupIncompleteItem {
  id: string
  label: string
  tab: SetupSettingsTab
}

export type SetupCheckInput = Pick<AppSettings, 'pythonPath'> & {
  sharedComfy: SharedComfyDraft
}

const CHECKS: Array<{
  id: string
  label: string
  tab: SetupSettingsTab
  getValue: (s: SetupCheckInput) => string
}> = [
  {
    id: 'ditModelFolder',
    label: 'DiT model folder',
    tab: 'wan22',
    getValue: (s) => s.sharedComfy.ditModelFolder
  },
  {
    id: 'speedLoraFolder',
    label: 'Speed LoRA folder',
    tab: 'wan22',
    getValue: (s) => s.sharedComfy.speedLoraFolder
  },
  {
    id: 'wan22LoraFolder',
    label: 'Wan22 LoRA folder',
    tab: 'wan22',
    getValue: (s) => s.sharedComfy.wan22LoraFolder
  },
  {
    id: 'upscaleModelFolder',
    label: 'Upscale model folder',
    tab: 'wan22',
    getValue: (s) => s.sharedComfy.upscaleModelFolder
  },
  {
    id: 'frameInterpModelFolder',
    label: 'Frame Interpolation model folder',
    tab: 'wan22',
    getValue: (s) => s.sharedComfy.frameInterpModelFolder
  },
  {
    id: 'vaePath',
    label: 'VAE',
    tab: 'wan22',
    getValue: (s) => s.sharedComfy.vaePath
  },
  {
    id: 'clipPath',
    label: 'CLIP / UMT5',
    tab: 'wan22',
    getValue: (s) => s.sharedComfy.clipPath
  },
  {
    id: 'comfyUiBatPath',
    label: 'ComfyUI launch bat',
    tab: 'comfy',
    getValue: (s) => s.sharedComfy.comfyUiBatPath
  },
  {
    id: 'pythonPath',
    label: 'Python executable',
    tab: 'ui',
    getValue: (s) => s.pythonPath
  }
]

export function getIncompleteSetupItems(settings: SetupCheckInput): SetupIncompleteItem[] {
  return CHECKS.filter((c) => !c.getValue(settings).trim()).map(({ id, label, tab }) => ({
    id,
    label,
    tab
  }))
}

export function hasIncompleteSetup(settings: SetupCheckInput): boolean {
  return getIncompleteSetupItems(settings).length > 0
}

export function firstIncompleteTab(settings: SetupCheckInput): SetupSettingsTab | null {
  return getIncompleteSetupItems(settings)[0]?.tab ?? null
}

export function isSetupItemIncomplete(
  settings: SetupCheckInput,
  id: SetupIncompleteItem['id']
): boolean {
  return getIncompleteSetupItems(settings).some((item) => item.id === id)
}

export function tabHasIncompleteSetup(
  settings: SetupCheckInput,
  tab: SetupSettingsTab
): boolean {
  return getIncompleteSetupItems(settings).some((item) => item.tab === tab)
}
