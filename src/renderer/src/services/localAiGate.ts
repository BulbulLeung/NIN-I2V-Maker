/** Global gate: Local AI (translate / prompt gen) paused while video is generating. */

let blocked = false

export function setLocalAiBlocked(next: boolean): void {
  blocked = Boolean(next)
}

export function isLocalAiBlocked(): boolean {
  return blocked
}

export function assertLocalAiAllowed(): void {
  if (blocked) {
    throw new Error('Local AI is paused while video is generating')
  }
}
