/**
 * Resolution math aligned with DaSiWa_ResolutionScaleCalculator
 * (WAN/LTX Div32 mode) from the Wan22 Loop workflow.
 */

export const RESOLUTION_PRESETS: Record<string, number> = {
  '144p': 0.04,
  '240p': 0.1,
  '360p': 0.23,
  '480p': 0.38,
  '540p': 0.52,
  '576p': 0.59,
  '720p': 0.92,
  '900p': 1.44,
  '1080p': 2.07,
  '1152p': 2.36,
  '1440p': 3.68,
  '2160p': 8.29,
  '2K': 4.19,
  '4K': 8.29
}

export const RESOLUTION_PRESET_OPTIONS = Object.keys(RESOLUTION_PRESETS)

export const ASPECT_PRESETS: Record<string, { w: number; h: number }> = {
  '1:1 - Square': { w: 1, h: 1 },
  '2:3 - Classic': { w: 2, h: 3 },
  '3:4 - Photo': { w: 3, h: 4 },
  '5:8 - Tall': { w: 5, h: 8 },
  '9:16 - Social': { w: 9, h: 16 },
  '9:21 - Cinema': { w: 9, h: 21 },
  '16:9 - Landscape': { w: 16, h: 9 },
  '3:2 - Photo W': { w: 3, h: 2 },
  '4:3 - Classic W': { w: 4, h: 3 }
}

export const ASPECT_PRESET_OPTIONS = Object.keys(ASPECT_PRESETS)

export const DEFAULT_RESOLUTION_PRESET = '540p'
export const DEFAULT_ASPECT_PRESET = '9:16 - Social'

export function isResolutionPreset(value: string): boolean {
  return Object.prototype.hasOwnProperty.call(RESOLUTION_PRESETS, value)
}

export function isAspectPreset(value: string): boolean {
  return Object.prototype.hasOwnProperty.call(ASPECT_PRESETS, value)
}

/** WAN/LTX Div32 snap — same as workflow mode. */
export function resolveWanResolution(opts: {
  resolutionPreset: string
  aspectW: number
  aspectH: number
}): { width: number; height: number } {
  const mp = RESOLUTION_PRESETS[opts.resolutionPreset] ?? RESOLUTION_PRESETS[DEFAULT_RESOLUTION_PRESET]
  const sourceW = Math.max(1, opts.aspectW)
  const sourceH = Math.max(1, opts.aspectH)
  const aspectRatio = sourceW / sourceH
  const targetPixels = mp * 1_000_000
  const calcW = Math.sqrt(targetPixels * aspectRatio)
  const calcH = Math.sqrt(targetPixels / aspectRatio)
  const width = Math.max(32, Math.round(calcW / 32) * 32)
  const height = Math.max(32, Math.round(calcH / 32) * 32)
  return { width, height }
}

export function loadImageNaturalSize(imagePath: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      resolve({
        width: Math.max(1, img.naturalWidth || 1),
        height: Math.max(1, img.naturalHeight || 1)
      })
    }
    img.onerror = () => reject(new Error('Failed to read image size'))
    img.src = window.api.toLocalUrl(imagePath)
  })
}
