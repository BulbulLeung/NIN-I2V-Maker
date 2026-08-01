/** Sidecar `.txt` format: optional motion note + English I2V prompt. */

const MOTION_MARKER = '<<<MOTION_NOTE>>>'
const PROMPT_MARKER = '<<<PROMPT>>>'

export interface SidecarCaption {
  motionNote: string
  prompt: string
}

/** Parse sidecar text. Plain files (no markers) are treated as prompt-only. */
export function parseSidecarCaption(raw: string): SidecarCaption {
  const text = raw ?? ''
  const motionIdx = text.indexOf(MOTION_MARKER)
  const promptIdx = text.indexOf(PROMPT_MARKER)

  if (motionIdx < 0 && promptIdx < 0) {
    return { motionNote: '', prompt: text }
  }

  let motionNote = ''
  let prompt = ''

  if (motionIdx >= 0 && promptIdx >= 0) {
    if (motionIdx < promptIdx) {
      motionNote = text.slice(motionIdx + MOTION_MARKER.length, promptIdx)
      prompt = text.slice(promptIdx + PROMPT_MARKER.length)
    } else {
      prompt = text.slice(promptIdx + PROMPT_MARKER.length, motionIdx)
      motionNote = text.slice(motionIdx + MOTION_MARKER.length)
    }
  } else if (motionIdx >= 0) {
    motionNote = text.slice(motionIdx + MOTION_MARKER.length)
  } else if (promptIdx >= 0) {
    prompt = text.slice(promptIdx + PROMPT_MARKER.length)
  }

  return {
    motionNote: motionNote.replace(/^\r?\n/, '').replace(/\s+$/, ''),
    prompt: prompt.replace(/^\r?\n/, '').replace(/\s+$/, '')
  }
}

/** Serialize motion note + prompt for `.txt`. Plain prompt when note is empty (compat). */
export function serializeSidecarCaption(motionNote: string, prompt: string): string {
  const note = (motionNote || '').trimEnd()
  const p = (prompt || '').trimEnd()
  if (!note.trim()) {
    return p
  }
  return `${MOTION_MARKER}\n${note}\n${PROMPT_MARKER}\n${p}\n`
}

export function sidecarHasContent(motionNote: string, prompt: string): boolean {
  return Boolean((motionNote || '').trim() || (prompt || '').trim())
}
