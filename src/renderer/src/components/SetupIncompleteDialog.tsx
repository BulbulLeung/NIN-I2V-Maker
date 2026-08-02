import { useEffect, useState } from 'react'
import type { SetupIncompleteItem } from '../utils/setupCompleteness'

interface Props {
  open: boolean
  items: SetupIncompleteItem[]
  onClose: () => void
  onOpenSettings: () => void
}

type FocusedAction = 'close' | 'openSettings'

export function SetupIncompleteDialog({ open, items, onClose, onOpenSettings }: Props) {
  const [focused, setFocused] = useState<FocusedAction>('openSettings')

  useEffect(() => {
    if (!open) return
    setFocused('openSettings')
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault()
        e.stopPropagation()
        setFocused((prev) => (prev === 'close' ? 'openSettings' : 'close'))
        return
      }
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        e.stopPropagation()
        if (focused === 'openSettings') onOpenSettings()
        else onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, focused, onClose, onOpenSettings])

  if (!open) return null

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal confirm-modal setup-incomplete-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Setup incomplete"
        onClick={(e) => e.stopPropagation()}
      >
        <h2>Setup incomplete</h2>
        <p className="confirm-modal-message">
          Finish these Settings before generating:
        </p>
        <ul className="setup-incomplete-list">
          {items.map((item) => (
            <li key={item.id}>{item.label}</li>
          ))}
        </ul>
        <div className="modal-actions">
          <button
            type="button"
            className={focused === 'close' ? 'kbd-focus' : undefined}
            aria-selected={focused === 'close'}
            onMouseEnter={() => setFocused('close')}
            onClick={onClose}
          >
            Close
          </button>
          <span className="spacer" />
          <button
            type="button"
            className={`primary${focused === 'openSettings' ? ' kbd-focus' : ''}`}
            aria-selected={focused === 'openSettings'}
            onMouseEnter={() => setFocused('openSettings')}
            onClick={onOpenSettings}
          >
            Open Settings
          </button>
        </div>
      </div>
    </div>
  )
}
