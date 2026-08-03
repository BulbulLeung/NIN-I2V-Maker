import type { GalleryVideoMeta } from './SharedGenerateGalleryContext'

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export function formatVideoMetaLine(meta: GalleryVideoMeta): string {
  const parts: string[] = []
  if (meta.seed != null) parts.push(`seed ${meta.seed}`)
  if (meta.width && meta.height) parts.push(`${meta.width}×${meta.height}`)
  if (meta.sizeBytes > 0) parts.push(formatFileSize(meta.sizeBytes))
  if (meta.codec) {
    parts.push(meta.codec)
    if (meta.bitDepth) parts.push(`${meta.bitDepth}bit`)
  } else if (meta.container) {
    parts.push(meta.container)
  }
  if (meta.prompt?.trim()) parts.push('prompt')
  return parts.join(' · ')
}

interface Props {
  meta: GalleryVideoMeta
  onUseSeed?: (seed: number) => void
  onUsePrompt?: (prompt: string) => void
  onStatus?: (msg: string, isError?: boolean) => void
}

export function GalleryVideoMetaBar({ meta, onUseSeed, onUsePrompt, onStatus }: Props) {
  const canUseSeed = Boolean(onUseSeed) && meta.seed != null
  const promptText = (meta.prompt || '').trim()
  const canUsePrompt = Boolean(onUsePrompt) && promptText.length > 0
  return (
    <div className="generate-video-meta">
      <button
        type="button"
        className="generate-use-seed-btn"
        disabled={!canUseSeed}
        title={
          meta.seed != null
            ? onUseSeed
              ? `Copy seed ${meta.seed} into Seed field`
              : `Seed ${meta.seed}`
            : 'No seed in video metadata'
        }
        onClick={() => {
          if (!onUseSeed || meta.seed == null) return
          onUseSeed(meta.seed)
          onStatus?.(`Seed set to ${meta.seed}`)
        }}
      >
        Use Seed
      </button>
      {onUsePrompt ? (
        <button
          type="button"
          className="generate-use-seed-btn"
          disabled={!canUsePrompt}
          title={
            canUsePrompt
              ? 'Copy prompt from video metadata into Prompt field'
              : 'No prompt in video metadata'
          }
          onClick={() => {
            if (!canUsePrompt) return
            onUsePrompt(promptText)
            onStatus?.('Prompt copied from video metadata')
          }}
        >
          Use Prompt
        </button>
      ) : null}
      <div className="generate-video-meta-text">
        <div className="generate-video-meta-name" title={meta.name}>
          {meta.name}
        </div>
        <div
          className="generate-video-meta-details"
          title={promptText || undefined}
        >
          {formatVideoMetaLine(meta)}
        </div>
      </div>
    </div>
  )
}
