import { useEffect, useState } from 'react'
import { useBackdropDismiss } from '../hooks/useBackdropDismiss'

interface Props {
  open: boolean
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  onConfirm: () => void
  onCancel: () => void
}

type FocusedAction = 'cancel' | 'confirm'

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Delete',
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel
}: Props) {
  const [focused, setFocused] = useState<FocusedAction>('cancel')

  useEffect(() => {
    if (!open) return
    setFocused('cancel')
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onCancel()
        return
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault()
        e.stopPropagation()
        setFocused((prev) => (prev === 'cancel' ? 'confirm' : 'cancel'))
        return
      }
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        e.stopPropagation()
        if (focused === 'confirm') onConfirm()
        else onCancel()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, focused, onCancel, onConfirm])

  const backdrop = useBackdropDismiss(onCancel)

  if (!open) return null

  return (
    <div className="modal-backdrop" role="presentation" {...backdrop}>
      <div className="modal confirm-modal" role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        <p className="confirm-modal-message">{message}</p>
        <div className="modal-actions">
          <button
            type="button"
            className={focused === 'cancel' ? 'kbd-focus' : undefined}
            aria-selected={focused === 'cancel'}
            onMouseEnter={() => setFocused('cancel')}
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <span className="spacer" />
          <button
            type="button"
            className={`danger${focused === 'confirm' ? ' kbd-focus' : ''}`}
            aria-selected={focused === 'confirm'}
            onMouseEnter={() => setFocused('confirm')}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
