import { useEffect, useId, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useBackdropDismiss } from '../hooks/useBackdropDismiss'

interface Props {
  /** Popup title; defaults to "About this setting". */
  title?: string
  children: ReactNode
}

export function FieldHintIcon({ title = 'About this setting', children }: Props) {
  const [open, setOpen] = useState(false)
  const titleId = useId()
  const close = () => setOpen(false)
  const backdrop = useBackdropDismiss(close)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setOpen(false)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open])

  return (
    <>
      <button
        type="button"
        className="field-hint-icon"
        aria-label={`Help: ${title}`}
        title="Help"
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setOpen(true)
        }}
      >
        !
      </button>
      {open &&
        createPortal(
          <div
            className="modal-backdrop field-hint-popup-backdrop"
            role="presentation"
            onMouseDown={(e) => {
              e.stopPropagation()
              backdrop.onMouseDown(e)
            }}
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              backdrop.onClick(e)
            }}
          >
            <div
              className="modal field-hint-popup"
              role="dialog"
              aria-modal="true"
              aria-labelledby={titleId}
            >
              <h2 id={titleId}>{title}</h2>
              <div className="field-hint-popup-body">{children}</div>
              <div className="modal-actions">
                <span className="spacer" />
                <button
                  type="button"
                  className="primary"
                  onClick={() => setOpen(false)}
                >
                  OK
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
    </>
  )
}
