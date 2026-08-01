/** ComfyUI Wan2.2 14B I2V client via main-process HTTP proxy. */

export const COMFY_BASE_URL = 'http://127.0.0.1:8188'

export interface ComfyI2vParams {
  prompt: string
  negative: string
  steps: number
  cfg: number
  seed: number
  width: number
  height: number
  length: number
  fps: number
  shift: number
  sampler: string
  scheduler: string
  /** Filename under diffusion_models (high noise). */
  highDitName: string
  /** Filename under diffusion_models (low noise). */
  lowDitName: string
  /** Filename under vae. */
  vaeName: string
  /** UMT5 filename under text_encoders / clip. */
  clipName: string
  /** Optional LoRA filenames (model-only). */
  loraHighName?: string
  loraLowName?: string
  loraStrength?: number
  useLightningLora?: boolean
  /** Already uploaded Comfy input image name. */
  uploadedImageName: string
  uploadedSubfolder?: string
  uploadedType?: string
  /** SaveVideo filename_prefix */
  savePrefix?: string
}

export interface ComfyVideoRef {
  filename: string
  subfolder: string
  type: string
  format?: string
}

function clientId(): string {
  return `i2vmaker-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

async function comfyHttp(
  url: string,
  init?: { method?: string; body?: string; timeoutMs?: number }
): Promise<{ ok: boolean; status: number; text: string; error?: string }> {
  return window.api.comfyHttpRequest({
    url,
    method: init?.method || 'GET',
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    body: init?.body,
    timeoutMs: init?.timeoutMs
  })
}

export function basenamePath(fullPath: string): string {
  const norm = fullPath.replace(/\\/g, '/')
  const i = norm.lastIndexOf('/')
  return i >= 0 ? fullPath.slice(i + 1) : fullPath
}

export function parentDir(fullPath: string): string {
  const norm = fullPath.replace(/\\/g, '/')
  const i = norm.lastIndexOf('/')
  if (i < 0) return ''
  return fullPath.slice(0, i)
}

/**
 * Official Wan2.2 14B I2V API graph (simplified, no UI switch nodes).
 * Dual UNET + WanImageToVideo + dual KSamplerAdvanced + CreateVideo/SaveVideo.
 */
export function buildWan22I2vWorkflow(p: ComfyI2vParams): Record<string, unknown> {
  const strength = p.loraStrength ?? 1
  const highLoraName = (p.loraHighName || '').trim()
  const lowLoraName = (p.loraLowName || '').trim()
  const useHighLora = Boolean(highLoraName)
  const useLowLora = Boolean(lowLoraName)

  const steps = Math.max(2, Math.floor(p.steps))
  const splitAt = Math.max(1, Math.floor(steps / 2))
  const seed =
    p.seed < 0 ? Math.floor(Math.random() * 1_000_000_000_000) : Math.floor(p.seed)

  const highModelNode = useHighLora ? '21' : '11'
  const lowModelNode = useLowLora ? '22' : '12'

  const graph: Record<string, unknown> = {
    '1': {
      class_type: 'UNETLoader',
      inputs: {
        unet_name: p.highDitName,
        weight_dtype: 'default'
      }
    },
    '2': {
      class_type: 'UNETLoader',
      inputs: {
        unet_name: p.lowDitName,
        weight_dtype: 'default'
      }
    },
    '3': {
      class_type: 'CLIPLoader',
      inputs: {
        clip_name: p.clipName,
        type: 'wan',
        device: 'default'
      }
    },
    '4': {
      class_type: 'VAELoader',
      inputs: {
        vae_name: p.vaeName
      }
    },
    '5': {
      class_type: 'CLIPTextEncode',
      inputs: {
        text: p.prompt,
        clip: ['3', 0]
      }
    },
    '6': {
      class_type: 'CLIPTextEncode',
      inputs: {
        text: p.negative || '',
        clip: ['3', 0]
      }
    },
    '7': {
      class_type: 'LoadImage',
      inputs: {
        image: p.uploadedSubfolder
          ? `${p.uploadedSubfolder}/${p.uploadedImageName}`
          : p.uploadedImageName
      }
    },
    '8': {
      class_type: 'WanImageToVideo',
      inputs: {
        positive: ['5', 0],
        negative: ['6', 0],
        vae: ['4', 0],
        start_image: ['7', 0],
        width: p.width,
        height: p.height,
        length: p.length,
        batch_size: 1
      }
    },
    '11': {
      class_type: 'ModelSamplingSD3',
      inputs: {
        model: ['1', 0],
        shift: p.shift
      }
    },
    '12': {
      class_type: 'ModelSamplingSD3',
      inputs: {
        model: ['2', 0],
        shift: p.shift
      }
    },
    '13': {
      class_type: 'KSamplerAdvanced',
      inputs: {
        model: [highModelNode, 0],
        add_noise: 'enable',
        noise_seed: seed,
        steps,
        cfg: p.cfg,
        sampler_name: p.sampler,
        scheduler: p.scheduler,
        positive: ['8', 0],
        negative: ['8', 1],
        latent_image: ['8', 2],
        start_at_step: 0,
        end_at_step: splitAt,
        return_with_leftover_noise: 'enable'
      }
    },
    '14': {
      class_type: 'KSamplerAdvanced',
      inputs: {
        model: [lowModelNode, 0],
        add_noise: 'disable',
        noise_seed: 0,
        steps,
        cfg: p.cfg,
        sampler_name: p.sampler,
        scheduler: p.scheduler,
        positive: ['8', 0],
        negative: ['8', 1],
        latent_image: ['13', 0],
        start_at_step: splitAt,
        end_at_step: steps,
        return_with_leftover_noise: 'disable'
      }
    },
    '15': {
      class_type: 'VAEDecode',
      inputs: {
        samples: ['14', 0],
        vae: ['4', 0]
      }
    },
    '16': {
      class_type: 'CreateVideo',
      inputs: {
        images: ['15', 0],
        fps: p.fps
      }
    },
    '17': {
      class_type: 'SaveVideo',
      inputs: {
        video: ['16', 0],
        filename_prefix: p.savePrefix || 'i2v/Wan2.2_i2v',
        format: 'auto',
        codec: 'auto'
      }
    }
  }

  if (useHighLora) {
    graph['21'] = {
      class_type: 'LoraLoaderModelOnly',
      inputs: {
        model: ['11', 0],
        lora_name: highLoraName,
        strength_model: strength
      }
    }
  }
  if (useLowLora) {
    graph['22'] = {
      class_type: 'LoraLoaderModelOnly',
      inputs: {
        model: ['12', 0],
        lora_name: lowLoraName,
        strength_model: strength
      }
    }
  }

  return graph
}

async function waitForPromptDone(
  promptId: string,
  baseUrl: string,
  signal?: AbortSignal,
  timeoutMs = 3_600_000
): Promise<Record<string, unknown>> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (signal?.aborted) throw new Error('Generation cancelled')
    const res = await comfyHttp(`${baseUrl}/history/${promptId}`, { timeoutMs: 30_000 })
    if (res.ok && res.text) {
      try {
        const hist = JSON.parse(res.text) as Record<
          string,
          {
            outputs?: Record<string, unknown>
            status?: { status_str?: string; completed?: boolean }
          }
        >
        const entry = hist[promptId]
        if (entry) {
          const statusStr = entry.status?.status_str
          if (statusStr === 'error') {
            throw new Error('ComfyUI reported an error while generating video')
          }
          if (entry.status?.completed || entry.outputs) {
            return entry as unknown as Record<string, unknown>
          }
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('ComfyUI')) throw err
      }
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error(`Timed out waiting for ComfyUI (${Math.round(timeoutMs / 60000)} min)`)
}

function collectVideoRefs(outputs: Record<string, unknown> | undefined): ComfyVideoRef[] {
  if (!outputs) return []
  const refs: ComfyVideoRef[] = []
  for (const nodeOut of Object.values(outputs)) {
    if (!nodeOut || typeof nodeOut !== 'object') continue
    const o = nodeOut as Record<string, unknown>
    for (const key of ['videos', 'gifs', 'images']) {
      const arr = o[key]
      if (!Array.isArray(arr)) continue
      for (const item of arr) {
        if (!item || typeof item !== 'object') continue
        const v = item as Record<string, unknown>
        if (typeof v.filename !== 'string') continue
        refs.push({
          filename: v.filename,
          subfolder: typeof v.subfolder === 'string' ? v.subfolder : '',
          type: typeof v.type === 'string' ? v.type : 'output',
          format: typeof v.format === 'string' ? v.format : undefined
        })
      }
    }
  }
  return refs
}

export async function interruptComfyGeneration(baseUrl = COMFY_BASE_URL): Promise<void> {
  await comfyHttp(`${baseUrl}/interrupt`, { method: 'POST', body: '{}', timeoutMs: 10_000 })
  await comfyHttp(`${baseUrl}/queue`, {
    method: 'POST',
    body: JSON.stringify({ clear: true }),
    timeoutMs: 10_000
  })
}

export async function probeComfyOnline(baseUrl = COMFY_BASE_URL): Promise<boolean> {
  const res = await comfyHttp(`${baseUrl}/system_stats`, { timeoutMs: 5_000 })
  return res.ok
}

export async function generateI2vWithComfy(
  params: ComfyI2vParams,
  opts?: { signal?: AbortSignal; baseUrl?: string }
): Promise<{ promptId: string; seed: number; videos: ComfyVideoRef[] }> {
  const baseUrl = (opts?.baseUrl || COMFY_BASE_URL).replace(/\/$/, '')
  const signal = opts?.signal

  const seed =
    params.seed < 0 ? Math.floor(Math.random() * 1_000_000_000_000) : Math.floor(params.seed)
  const workflow = buildWan22I2vWorkflow({ ...params, seed })

  const body = JSON.stringify({
    prompt: workflow,
    client_id: clientId()
  })

  const queued = await comfyHttp(`${baseUrl}/prompt`, {
    method: 'POST',
    body,
    timeoutMs: 60_000
  })
  if (!queued.ok) {
    throw new Error(
      `ComfyUI /prompt failed (${queued.status}): ${queued.error || queued.text || 'unknown'}`
    )
  }

  let promptId = ''
  try {
    const parsed = JSON.parse(queued.text) as { prompt_id?: string; error?: unknown }
    if (parsed.error) {
      throw new Error(`ComfyUI rejected prompt: ${JSON.stringify(parsed.error)}`)
    }
    promptId = parsed.prompt_id || ''
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('ComfyUI')) throw err
    throw new Error(`Invalid ComfyUI /prompt response: ${queued.text}`)
  }
  if (!promptId) throw new Error('ComfyUI returned empty prompt_id')

  const done = await waitForPromptDone(promptId, baseUrl, signal)
  const outputs = (done as { outputs?: Record<string, unknown> }).outputs
  const videos = collectVideoRefs(outputs)
  if (videos.length === 0) {
    throw new Error('ComfyUI finished but no video was found in outputs')
  }
  return { promptId, seed, videos }
}
