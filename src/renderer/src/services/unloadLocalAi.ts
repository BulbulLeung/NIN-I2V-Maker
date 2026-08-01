import type { AppSettings } from '../types'

const UNLOAD_TIMEOUT_MS = 15_000

export interface UnloadLocalAiResult {
  ollamaUnloaded: string[]
  lmStudioUnloaded: string[]
  notes: string[]
}

function withTimeout(ms: number): AbortSignal {
  const ctrl = new AbortController()
  setTimeout(() => ctrl.abort('timeout'), ms)
  return ctrl.signal
}

/** Strip trailing /v1 (OpenAI-compat path) to get LM Studio server root. */
export function lmStudioServerRoot(lmStudioBaseUrl: string): string {
  let base = (lmStudioBaseUrl || '').trim().replace(/\/$/, '')
  if (base.toLowerCase().endsWith('/v1')) {
    base = base.slice(0, -3).replace(/\/$/, '')
  }
  return base
}

async function fetchJson(
  url: string,
  init?: RequestInit
): Promise<{ ok: boolean; status: number; json: unknown; text: string }> {
  try {
    const res = await fetch(url, { ...init, signal: withTimeout(UNLOAD_TIMEOUT_MS) })
    const text = await res.text().catch(() => '')
    let json: unknown = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null
    }
    return { ok: res.ok, status: res.status, json, text }
  } catch {
    return { ok: false, status: 0, json: null, text: '' }
  }
}

async function unloadOllamaModels(
  ollamaBaseUrl: string,
  preferredModel?: string
): Promise<{ unloaded: string[]; note?: string }> {
  const base = (ollamaBaseUrl || '').trim().replace(/\/$/, '')
  if (!base) return { unloaded: [] }

  const ps = await fetchJson(`${base}/api/ps`)
  if (!ps.ok && ps.status === 0) {
    return { unloaded: [] } // not running
  }
  if (!ps.ok) {
    return { unloaded: [], note: `Ollama /api/ps failed (${ps.status})` }
  }

  const models = new Set<string>()
  const data = ps.json as { models?: { name?: string; model?: string }[] } | null
  if (Array.isArray(data?.models)) {
    for (const m of data.models) {
      const name = (m.name || m.model || '').trim()
      if (name) models.add(name)
    }
  }
  const preferred = (preferredModel || '').trim()
  if (preferred) models.add(preferred)

  const unloaded: string[] = []
  for (const model of models) {
    const res = await fetchJson(`${base}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, keep_alive: 0 })
    })
    if (res.ok) unloaded.push(model)
  }
  return { unloaded }
}

async function unloadLmStudioModels(lmStudioBaseUrl: string): Promise<{
  unloaded: string[]
  note?: string
}> {
  const root = lmStudioServerRoot(lmStudioBaseUrl)
  if (!root) return { unloaded: [] }

  const unloaded: string[] = []
  const instanceIds = new Set<string>()

  // Native v1 list → loaded_instances
  const v1 = await fetchJson(`${root}/api/v1/models`)
  if (v1.ok && v1.json && typeof v1.json === 'object') {
    const models = (v1.json as { models?: unknown }).models
    if (Array.isArray(models)) {
      for (const m of models) {
        if (!m || typeof m !== 'object') continue
        const instances = (m as { loaded_instances?: unknown }).loaded_instances
        if (!Array.isArray(instances)) continue
        for (const inst of instances) {
          if (!inst || typeof inst !== 'object') continue
          const id = String((inst as { id?: unknown }).id || '').trim()
          if (id) instanceIds.add(id)
        }
      }
    }
  } else if (v1.status === 0) {
    // Server not reachable
    return { unloaded: [] }
  }

  // Fallback: v0 list with state === loaded
  if (instanceIds.size === 0) {
    const v0 = await fetchJson(`${root}/api/v0/models`)
    if (v0.ok && v0.json && typeof v0.json === 'object') {
      const data = (v0.json as { data?: unknown }).data
      if (Array.isArray(data)) {
        for (const m of data) {
          if (!m || typeof m !== 'object') continue
          const row = m as { id?: unknown; state?: unknown }
          if (String(row.state || '').toLowerCase() === 'loaded') {
            const id = String(row.id || '').trim()
            if (id) instanceIds.add(id)
          }
        }
      }
    }
  }

  if (instanceIds.size === 0) {
    return { unloaded: [] }
  }

  let unloadFailed = 0
  for (const instance_id of instanceIds) {
    const res = await fetchJson(`${root}/api/v1/models/unload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instance_id })
    })
    if (res.ok) {
      unloaded.push(instance_id)
    } else {
      unloadFailed++
    }
  }

  if (unloaded.length === 0 && unloadFailed > 0) {
    return {
      unloaded: [],
      note: 'LM Studio models are loaded but unload API is unavailable (update LM Studio for /api/v1/models/unload)'
    }
  }
  return { unloaded }
}

/**
 * Best-effort: unload any models currently in VRAM on LM Studio and/or Ollama.
 * Unreachable servers are ignored. Does not block video generation on failure.
 */
export async function unloadLocalAiModels(settings: AppSettings): Promise<UnloadLocalAiResult> {
  const notes: string[] = []
  const [ollama, lm] = await Promise.all([
    unloadOllamaModels(settings.ollamaBaseUrl, settings.model),
    unloadLmStudioModels(settings.lmStudioBaseUrl)
  ])
  if (ollama.note) notes.push(ollama.note)
  if (lm.note) notes.push(lm.note)
  return {
    ollamaUnloaded: ollama.unloaded,
    lmStudioUnloaded: lm.unloaded,
    notes
  }
}
