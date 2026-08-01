import { useEffect, type RefObject } from 'react'

/** True when focus is in a text/control field where arrows should edit, not navigate. */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  const el = target instanceof HTMLElement ? target : target.parentElement
  if (!el) return false
  const tag = el.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag === 'INPUT') return true
  if (el.isContentEditable) return true
  if (el.closest('textarea, select, input, [contenteditable="true"]')) return true
  return false
}

function measureGridColumns(container: HTMLElement, itemSelector: string): number {
  const items = container.querySelectorAll(itemSelector)
  if (items.length < 2) return 1
  const first = items[0] as HTMLElement
  const firstTop = first.offsetTop
  let cols = 1
  for (let i = 1; i < items.length; i++) {
    const el = items[i] as HTMLElement
    if (el.offsetTop !== firstTop) break
    cols++
  }
  return Math.max(1, cols)
}

function resolveNextIndex(
  key: string,
  current: number,
  length: number,
  columns: number
): number | null {
  if (length <= 0) return null
  if (current < 0) {
    if (key === 'ArrowRight' || key === 'ArrowDown') return 0
    if (key === 'ArrowLeft' || key === 'ArrowUp') return length - 1
    return null
  }
  let next = current
  if (key === 'ArrowLeft') next = current - 1
  else if (key === 'ArrowRight') next = current + 1
  else if (key === 'ArrowUp') next = current - columns
  else if (key === 'ArrowDown') next = current + columns
  else return null
  if (next < 0 || next >= length) return null
  return next
}

export interface UseArrowListNavOptions {
  enabled: boolean
  items: readonly string[]
  selectedId: string | null
  onSelect: (id: string) => void
  /**
   * `1` — Up/Down/Left/Right all step by one (list / horizontal strip).
   * `'auto'` — measure columns from the container for grid navigation.
   * number — fixed column count.
   */
  columns?: number | 'auto'
  containerRef?: RefObject<HTMLElement | null>
  /** Used with `columns: 'auto'` and scroll-into-view. Default: `[data-nav-id]` */
  itemSelector?: string
  /** Extra gate — return true to skip handling this event. */
  shouldIgnore?: (e: KeyboardEvent) => boolean
}

/**
 * When not focused in an input, arrow keys move selection through a list/grid.
 */
export function useArrowListNav({
  enabled,
  items,
  selectedId,
  onSelect,
  columns = 1,
  containerRef,
  itemSelector = '[data-nav-id]',
  shouldIgnore
}: UseArrowListNavOptions): void {
  useEffect(() => {
    if (!enabled || items.length === 0) return

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      if (e.altKey || e.ctrlKey || e.metaKey) return
      if (
        e.key !== 'ArrowLeft' &&
        e.key !== 'ArrowRight' &&
        e.key !== 'ArrowUp' &&
        e.key !== 'ArrowDown'
      ) {
        return
      }
      if (isTextEntryTarget(e.target)) return
      if (shouldIgnore?.(e)) return

      const cols =
        columns === 'auto'
          ? containerRef?.current
            ? measureGridColumns(containerRef.current, itemSelector)
            : 1
          : Math.max(1, columns)

      const current = selectedId ? items.indexOf(selectedId) : -1
      const next = resolveNextIndex(e.key, current, items.length, cols)
      if (next == null) {
        e.preventDefault()
        e.stopPropagation()
        return
      }

      const id = items[next]
      if (!id || id === selectedId) {
        e.preventDefault()
        e.stopPropagation()
        return
      }

      e.preventDefault()
      e.stopPropagation()
      onSelect(id)

      requestAnimationFrame(() => {
        const root = containerRef?.current
        if (!root) return
        const el = root.querySelector(`[data-nav-id="${CSS.escape(id)}"]`)
        if (el instanceof HTMLElement) {
          el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
        }
      })
    }

    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [
    enabled,
    items,
    selectedId,
    onSelect,
    columns,
    containerRef,
    itemSelector,
    shouldIgnore
  ])
}
