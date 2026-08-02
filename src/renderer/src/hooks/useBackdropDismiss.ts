import { useCallback, useRef, type MouseEvent } from 'react'

/**
 * Dismiss a modal only when the user presses and releases on the backdrop
 * (outside the panel). Dragging from the panel onto the backdrop will not close.
 */
export function useBackdropDismiss(onDismiss: () => void) {
  const pressedOnBackdrop = useRef(false)

  const onMouseDown = useCallback((e: MouseEvent<HTMLElement>) => {
    pressedOnBackdrop.current = e.target === e.currentTarget
  }, [])

  const onClick = useCallback(
    (e: MouseEvent<HTMLElement>) => {
      if (pressedOnBackdrop.current && e.target === e.currentTarget) {
        onDismiss()
      }
      pressedOnBackdrop.current = false
    },
    [onDismiss]
  )

  return { onMouseDown, onClick }
}
