import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction
} from 'react'

export interface GalleryVideo {
  path: string
  name: string
  mtimeMs: number
}

export interface GalleryVideoMeta {
  name: string
  sizeBytes: number
  width: number | null
  height: number | null
  codec: string | null
  bitDepth: number | null
  container: string | null
  seed: number | null
}

interface SharedGenerateGalleryValue {
  videos: GalleryVideo[]
  selectedVideo: string | null
  videoMeta: GalleryVideoMeta | null
  setSelectedVideo: Dispatch<SetStateAction<string | null>>
  setVideos: Dispatch<SetStateAction<GalleryVideo[]>>
  setVideoMeta: Dispatch<SetStateAction<GalleryVideoMeta | null>>
  refreshGallery: () => Promise<void>
}

const SharedGenerateGalleryContext = createContext<SharedGenerateGalleryValue | null>(null)

interface ProviderProps {
  outputFolder: string
  onStatus: (msg: string, isError?: boolean, options?: { sticky?: boolean }) => void
  children: ReactNode
}

export function SharedGenerateGalleryProvider({
  outputFolder,
  onStatus,
  children
}: ProviderProps) {
  const [videos, setVideos] = useState<GalleryVideo[]>([])
  const [selectedVideo, setSelectedVideo] = useState<string | null>(null)
  const [videoMeta, setVideoMeta] = useState<GalleryVideoMeta | null>(null)

  const refreshGallery = useCallback(async () => {
    const folder = outputFolder.trim()
    if (!folder) {
      setVideos([])
      setSelectedVideo(null)
      setVideoMeta(null)
      return
    }
    try {
      const res = await window.api.galleryListVideos({ outputFolder: folder })
      if (!res.ok) {
        onStatus(res.error || 'Failed to list gallery videos', true)
        return
      }
      const listed = res.videos.filter((v) => !/upscale/i.test(v.name))
      setVideos(listed)
      setSelectedVideo((prev) =>
        prev && listed.some((v) => v.path === prev) ? prev : (listed[0]?.path ?? null)
      )
    } catch (err) {
      onStatus(err instanceof Error ? err.message : String(err), true)
    }
  }, [outputFolder, onStatus])

  useEffect(() => {
    void refreshGallery()
  }, [refreshGallery])

  useEffect(() => {
    if (!selectedVideo) {
      setVideoMeta(null)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const res = await window.api.galleryProbeVideo({ path: selectedVideo })
        if (cancelled) return
        if (res.ok && res.info) {
          setVideoMeta({
            name: res.info.name,
            sizeBytes: res.info.sizeBytes,
            width: res.info.width,
            height: res.info.height,
            codec: res.info.codec,
            bitDepth: res.info.bitDepth,
            container: res.info.container,
            seed: res.info.seed ?? null
          })
        } else {
          const fallback = videos.find((v) => v.path === selectedVideo)
          setVideoMeta(
            fallback
              ? {
                  name: fallback.name,
                  sizeBytes: 0,
                  width: null,
                  height: null,
                  codec: null,
                  bitDepth: null,
                  container: null,
                  seed: null
                }
              : null
          )
        }
      } catch {
        if (!cancelled) setVideoMeta(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [selectedVideo, videos])

  const value = useMemo(
    () => ({
      videos,
      selectedVideo,
      videoMeta,
      setSelectedVideo,
      setVideos,
      setVideoMeta,
      refreshGallery
    }),
    [videos, selectedVideo, videoMeta, refreshGallery]
  )

  return (
    <SharedGenerateGalleryContext.Provider value={value}>
      {children}
    </SharedGenerateGalleryContext.Provider>
  )
}

export function useSharedGenerateGallery(): SharedGenerateGalleryValue {
  const ctx = useContext(SharedGenerateGalleryContext)
  if (!ctx) {
    throw new Error('useSharedGenerateGallery must be used within SharedGenerateGalleryProvider')
  }
  return ctx
}
