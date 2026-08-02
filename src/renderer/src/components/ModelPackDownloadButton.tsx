import { useEffect, useRef } from 'react'

export type ModelPackId =
  | 'dit'
  | 'speedLora'
  | 'wan22Lora'
  | 'upscale'
  | 'frameInterp'
  | 'vae'
  | 'clip'

interface Props {
  packId: ModelPackId
  downloadFolder: string
  /** Hide when the setting already has a value. */
  visible: boolean
  /** Button label when idle. */
  label?: string
  /** True while any pack download is active (global single-flight). */
  busyPackId: ModelPackId | null
  onBusyChange: (packId: ModelPackId | null) => void
  onProgress: (packId: ModelPackId, message: string, pct: number) => void
  onDone: (path: string) => void
  onError: (message: string) => void
}

export function ModelPackDownloadButton({
  packId,
  downloadFolder,
  visible,
  label = 'Download',
  busyPackId,
  onBusyChange,
  onProgress,
  onDone,
  onError
}: Props) {
  const offProgress = useRef<(() => void) | null>(null)
  const isThis = busyPackId === packId
  const anyBusy = busyPackId != null

  useEffect(() => {
    return () => {
      offProgress.current?.()
      offProgress.current = null
    }
  }, [])

  if (!visible && !isThis) return null

  const start = async () => {
    if (anyBusy) return
    onBusyChange(packId)
    onProgress(packId, 'Starting…', 0)
    offProgress.current?.()
    offProgress.current = window.api.onModelDownloadProgress((p) => {
      if (p.packId !== packId) return
      onProgress(packId, p.message, p.pct)
    })
    try {
      const result = await window.api.downloadModelPack({
        packId,
        downloadFolder: downloadFolder.trim() || undefined
      })
      if (result.ok && result.path) {
        onDone(result.path)
      } else {
        onError(result.message || 'Download failed')
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err))
    } finally {
      offProgress.current?.()
      offProgress.current = null
      onBusyChange(null)
    }
  }

  const cancel = async () => {
    await window.api.cancelModelDownload()
  }

  if (isThis) {
    return (
      <button type="button" onClick={() => void cancel()}>
        Cancel
      </button>
    )
  }

  return (
    <button
      type="button"
      className="primary"
      disabled={anyBusy}
      onClick={() => void start()}
    >
      {label}
    </button>
  )
}
