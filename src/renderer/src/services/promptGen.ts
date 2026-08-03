import type { AppSettings } from '../types'
import { formatLocalAiError } from './localAiError'
import { assertLocalAiAllowed } from './localAiGate'

const PROMPT_TIMEOUT_MS = 300_000

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  userSignal: AbortSignal | undefined,
  timeoutMs: number
): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort('timeout'), timeoutMs)
  const onUserAbort = () => ctrl.abort('cancel')
  if (userSignal) {
    if (userSignal.aborted) ctrl.abort('cancel')
    else userSignal.addEventListener('abort', onUserAbort, { once: true })
  }
  try {
    return await fetch(url, { ...init, signal: ctrl.signal })
  } catch (err) {
    const reason = ctrl.signal.reason
    if (reason === 'timeout') {
      throw new Error(
        `Prompt generation timed out (${Math.round(timeoutMs / 1000)}s). Check that the vision model is loaded.`
      )
    }
    if (reason === 'cancel') throw new Error('Prompt generation cancelled')
    throw err instanceof Error ? err : new Error(String(err))
  } finally {
    clearTimeout(timer)
    userSignal?.removeEventListener('abort', onUserAbort)
  }
}

/** Pull the clean I2V motion prompt from a multi-section model reply. */
export function extractFinalPrompt(raw: string): string {
  let text = raw.trim()
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()

  const section = text.match(
    /(?:###\s*2[\s\S]*?Final I2V Motion Prompt|Final I2V Motion Prompt\s*:?|###\s*2\.?[^\n]*)\s*([\s\S]*)/i
  )
  if (section?.[1]) {
    text = section[1].trim()
  }

  text = text.replace(/^[\s\S]*?(?:Final I2V Motion Prompt\s*:?\s*)/i, '').trim()

  const parts = text.split(/\n#{1,3}\s+/)
  if (parts.length > 1) {
    text = parts[parts.length - 1].trim()
  }

  text = text
    .replace(/^```(?:text|markdown)?\s*/i, '')
    .replace(/```$/i, '')
    .trim()

  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\n/g, ' ').trim())
    .filter(
      (p) =>
        p.length > 30 &&
        !/^[-*#]/.test(p) &&
        !/^(shot|camera|subject|timing|atmosphere)/i.test(p)
    )

  if (paragraphs.length > 0) {
    paragraphs.sort((a, b) => b.length - a.length)
    text = paragraphs[0]
  }

  return text.trim()
}

function activePreset(settings: AppSettings) {
  return (
    settings.promptPresets.find((p) => p.id === settings.activePromptPresetId) ??
    settings.promptPresets[0]
  )
}

function activePresetPrompt(settings: AppSettings): string {
  return activePreset(settings)?.prompt?.trim() ?? ''
}

function activePresetFixedPrompt(settings: AppSettings): string {
  return activePreset(settings)?.fixedPrompt?.trim() ?? ''
}

function withFixedPrompt(settings: AppSettings, generated: string): string {
  const fixed = activePresetFixedPrompt(settings)
  const text = generated.trim()
  if (!fixed) return text
  if (!text) return fixed
  return `${fixed}\n${text}`
}

async function promptWithLmStudio(
  settings: AppSettings,
  fullPrompt: string,
  mimeType: string,
  base64: string,
  signal?: AbortSignal
): Promise<string> {
  const model = settings.model || ''
  if (!model) throw new Error('Model is required in Settings')

  const url = `${settings.lmStudioBaseUrl.replace(/\/$/, '')}/chat/completions`
  const res = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        temperature: 0.35,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: fullPrompt },
              {
                type: 'image_url',
                image_url: { url: `data:${mimeType};base64,${base64}` }
              }
            ]
          }
        ]
      })
    },
    signal,
    PROMPT_TIMEOUT_MS
  )

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`LM Studio prompt error ${res.status}: ${body || res.statusText}`)
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[]
  }
  const content = data.choices?.[0]?.message?.content?.trim()
  if (!content) throw new Error('LM Studio returned empty prompt')
  return extractFinalPrompt(content)
}

async function promptWithOllama(
  settings: AppSettings,
  fullPrompt: string,
  base64: string,
  signal?: AbortSignal
): Promise<string> {
  const model = settings.model || ''
  if (!model) throw new Error('Model is required in Settings')

  const url = `${settings.ollamaBaseUrl.replace(/\/$/, '')}/api/chat`
  const res = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        think: false,
        keep_alive: '60m',
        messages: [
          {
            role: 'user',
            content: fullPrompt,
            images: [base64]
          }
        ],
        options: {
          temperature: 0.35,
          num_ctx: 8192,
          num_predict: 2048
        }
      })
    },
    signal,
    PROMPT_TIMEOUT_MS
  )

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Ollama prompt error ${res.status}: ${body || res.statusText}`)
  }

  const data = (await res.json()) as { message?: { content?: string } }
  const content = data.message?.content?.trim()
  if (!content) throw new Error('Ollama returned empty prompt')
  return extractFinalPrompt(content)
}

export async function generateI2vPromptForImage(
  settings: AppSettings,
  imagePath: string,
  signal?: AbortSignal,
  motionNote?: string,
  imagePositivePrompt?: string
): Promise<string> {
  assertLocalAiAllowed()
  const presetPrompt = activePresetPrompt(settings)
  if (!presetPrompt) throw new Error('No prompt preset selected')

  const note = (motionNote || '').trim()
  const embedded = (imagePositivePrompt || '').trim()
  let fullPrompt = presetPrompt
  if (embedded) {
    fullPrompt = `${fullPrompt}

=== EMBEDDED IMAGE POSITIVE PROMPT ===
The source image file embeds the following positive / generation prompt in its metadata.
Use it to clarify character identity, cast composition, expression, pose, wardrobe, and intended action.
- Prefer what the attached image actually shows when text and pixels conflict.
- Do not copy the embedded prompt verbatim into the I2V output; distill motion from image + this context.
- Still write a Wan 2.2 I2V English motion paragraph (camera / subject action / timing), not a static appearance dump.

Embedded Positive Prompt:
${embedded}
`
  }
  if (note) {
    fullPrompt = `${fullPrompt}

=== USER MOTION DESCRIPTION (HIGHEST PRIORITY) ===
A user-provided motion description is included below. Treat it as the authoritative intent for camera move, subject action, timing, and atmosphere.
- Use the image to ground who/what is visible, spatial layout, and starting pose.
- If the note conflicts with a possible reading of the image, FOLLOW THE USER NOTE.
- Expand the note into a polished Wan 2.2 I2V English motion paragraph; do not ignore or dilute it.

User Motion Description:
${note}
`
  }

  try {
    const image = await window.api.readImageBase64(imagePath)
    const generated =
      settings.provider === 'lmstudio'
        ? await promptWithLmStudio(
            settings,
            fullPrompt,
            image.mimeType,
            image.base64,
            signal
          )
        : await promptWithOllama(settings, fullPrompt, image.base64, signal)
    return withFixedPrompt(settings, generated)
  } catch (err) {
    throw new Error(formatLocalAiError(err, settings))
  }
}
