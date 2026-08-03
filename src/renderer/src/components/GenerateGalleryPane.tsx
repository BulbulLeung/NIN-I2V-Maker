import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { basenamePath } from '../services/comfyWan22Loop'
import { useArrowListNav, isTextEntryTarget } from '../hooks/useArrowListNav'
import { ConfirmDialog } from './ConfirmDialog'
import { GalleryVideoMetaBar } from './GalleryVideoMetaBar'
import {
  useSharedGenerateGallery
} from './SharedGenerateGalleryContext'

interface Props {
  /** False while Prompt / Upscale is shown (shell stays mounted). */
  active?: boolean
  outputFolder: string
  onUseSeed: (seed: number) => void
  onStatus: (msg: string, isError?: boolean, options?: { sticky?: boolean }) => void
}

export function GenerateGalleryPane({
  active = true,
  outputFolder,
  onUseSeed,
  onStatus
}: Props) {
  const {
    videos,
    selectedVideo,
    videoMeta,
    setSelectedVideo,
    setVideos,
    setVideoMeta,
    refreshGallery
  } = useSharedGenerateGallery()

  const [confirmDeleteVideo, setConfirmDeleteVideo] = useState(false)
  const galleryRef = useRef<HTMLDivElement | null>(null)
  const selectedVideoRef = useRef(selectedVideo)
  selectedVideoRef.current = selectedVideo
  const videosRef = useRef(videos)
  videosRef.current = videos

  const videoPaths = useMemo(() => videos.map((v) => v.path), [videos])

  const selectGalleryVideo = useCallback(
    (path: string) => {
      setSelectedVideo(path)
    },
    [setSelectedVideo]
  )

  const ignoreWhenOtherModal = useCallback((e: KeyboardEvent) => {
    if (
      document.querySelector(
        '.settings-modal, .confirm-modal, .setup-incomplete-modal, .lora-popup-modal, .generate-image-picker-modal'
      )
    ) {
      return true
    }
    const t = e.target
    if (t instanceof Element && t.closest('.lora-popup-modal')) return true
    return false
  }, [])

  useArrowListNav({
    enabled: active && !confirmDeleteVideo && videoPaths.length > 0,
    items: videoPaths,
    selectedId: selectedVideo,
    onSelect: selectGalleryVideo,
    columns: 1,
    containerRef: galleryRef,
    shouldIgnore: ignoreWhenOtherModal
  })

  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Delete') return
      if (e.defaultPrevented) return
      if (e.altKey || e.ctrlKey || e.metaKey) return
      if (isTextEntryTarget(e.target)) return
      if (
        document.querySelector(
          '.settings-modal, .confirm-modal, .lora-popup-modal, .setup-incomplete-modal, .generate-image-picker-modal'
        )
      ) {
        return
      }
      if (!selectedVideoRef.current) return
      e.preventDefault()
      e.stopPropagation()
      setConfirmDeleteVideo(true)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [active])

  const performDeleteVideo = useCallback(async () => {
    const path = selectedVideoRef.current
    setConfirmDeleteVideo(false)
    if (!path) return
    const res = await window.api.trashItem(path)
    if (!res.ok) {
      onStatus(res.error || 'Failed to move video to Recycle Bin', true)
      return
    }
    const list = videosRef.current
    const idx = list.findIndex((v) => v.path === path)
    const nextList = list.filter((v) => v.path !== path)
    setVideos(nextList)
    const nextPath = nextList[idx]?.path ?? nextList[idx - 1]?.path ?? null
    setSelectedVideo(nextPath)
    if (!nextPath) setVideoMeta(null)
    onStatus(`Moved to Recycle Bin: ${basenamePath(path)}`)
  }, [onStatus, setSelectedVideo, setVideoMeta, setVideos])

  return (
    <section className="generate-gallery">
      <div className="generate-gallery-header">
        <span>
          {videos.length} video{videos.length === 1 ? '' : 's'}
          {outputFolder ? ` · ${outputFolder}` : ''}
        </span>
        <div className="generate-gallery-header-actions">
          <button type="button" onClick={() => void refreshGallery()}>
            Refresh
          </button>
          <button
            type="button"
            disabled={!outputFolder.trim()}
            onClick={() => {
              void window.api.openPathInExplorer(outputFolder.trim())
            }}
          >
            Open folder
          </button>
        </div>
      </div>

      <div className="generate-video-player">
        {selectedVideo ? (
          <>
            <video
              key={selectedVideo}
              src={window.api.toLocalUrl(selectedVideo)}
              controls
              autoPlay
              loop
              onLoadedMetadata={(e) => {
                const el = e.currentTarget
                const w = el.videoWidth
                const h = el.videoHeight
                if (!w || !h) return
                setVideoMeta((prev) => {
                  if (!prev) return prev
                  if (prev.width && prev.height) return prev
                  return { ...prev, width: w, height: h }
                })
              }}
            />
            {videoMeta ? (
              <GalleryVideoMetaBar
                meta={videoMeta}
                onUseSeed={onUseSeed}
                onStatus={onStatus}
              />
            ) : null}
          </>
        ) : (
          <div className="generate-video-player-empty">
            {videos.length > 0
              ? 'Select a video below to preview'
              : outputFolder
                ? 'No videos in output folder yet'
                : 'Choose an output folder in Settings'}
          </div>
        )}
      </div>

      <div className="i2v-gallery" ref={galleryRef}>
        {videos.length === 0 ? (
          <div className="i2v-gallery-empty">No videos</div>
        ) : (
          videos.map((v) => (
            <button
              key={v.path}
              type="button"
              data-nav-id={v.path}
              className={`i2v-gallery-item${v.path === selectedVideo ? ' active' : ''}`}
              onClick={() => setSelectedVideo(v.path)}
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

      <ConfirmDialog
        open={confirmDeleteVideo}
        title="Delete video"
        message={
          selectedVideo
            ? `Move this video to the Recycle Bin?\n${basenamePath(selectedVideo)}`
            : 'Move this video to the Recycle Bin?'
        }
        onCancel={() => setConfirmDeleteVideo(false)}
        onConfirm={() => void performDeleteVideo()}
      />
    </section>
  )
}
