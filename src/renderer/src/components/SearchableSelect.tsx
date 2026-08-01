import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent
} from 'react'

export interface SearchableSelectOption {
  value: string
  label: string
}

interface Props {
  options: SearchableSelectOption[]
  value: string
  onChange: (value: string) => void
  placeholder?: string
  disabled?: boolean
  /** When set, shows a clearable empty option (e.g. "-NONE-"). */
  emptyLabel?: string
  className?: string
  title?: string
}

function matchesQuery(option: SearchableSelectOption, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return (
    option.label.toLowerCase().includes(q) || option.value.toLowerCase().includes(q)
  )
}

function styleFromTriggerRect(r: DOMRect): CSSProperties {
  const gap = 2
  const margin = 8
  const spaceBelow = window.innerHeight - r.bottom - gap - margin
  const spaceAbove = r.top - margin
  const preferBelow = spaceBelow >= 140 || spaceBelow >= spaceAbove
  const maxHeight = Math.min(256, Math.max(120, preferBelow ? spaceBelow : spaceAbove))
  const maxWidth = Math.max(r.width, window.innerWidth - margin * 2)
  const base: CSSProperties = {
    position: 'fixed',
    left: r.left,
    minWidth: r.width,
    width: 'max-content',
    maxWidth,
    maxHeight,
    zIndex: 80
  }
  if (preferBelow) {
    return { ...base, top: r.bottom + gap }
  }
  return { ...base, bottom: window.innerHeight - r.top + gap }
}

function clampPanelLeft(triggerLeft: number, panelWidth: number): number {
  const margin = 8
  if (triggerLeft + panelWidth <= window.innerWidth - margin) return triggerLeft
  return Math.max(margin, window.innerWidth - margin - panelWidth)
}

export function SearchableSelect({
  options,
  value,
  onChange,
  placeholder = 'Select…',
  disabled = false,
  emptyLabel,
  className,
  title
}: Props) {
  const listId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const [panelStyle, setPanelStyle] = useState<CSSProperties>({})

  const selected = useMemo(
    () => options.find((o) => o.value === value) ?? null,
    [options, value]
  )

  const filtered = useMemo(() => {
    const rows: SearchableSelectOption[] = []
    if (emptyLabel != null) {
      const emptyOpt = { value: '', label: emptyLabel }
      if (matchesQuery(emptyOpt, query)) rows.push(emptyOpt)
    }
    for (const opt of options) {
      if (matchesQuery(opt, query)) rows.push(opt)
    }
    return rows
  }, [options, emptyLabel, query])

  const displayLabel =
    value === '' && emptyLabel != null
      ? emptyLabel
      : selected?.label || (value ? value : placeholder)

  const close = () => {
    setOpen(false)
    setQuery('')
    setHighlight(0)
  }

  const updatePanelPosition = () => {
    const el = triggerRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPanelStyle(styleFromTriggerRect(r))
    requestAnimationFrame(() => {
      const panel = panelRef.current
      const trigger = triggerRef.current
      if (!panel || !trigger) return
      const tr = trigger.getBoundingClientRect()
      const left = clampPanelLeft(tr.left, panel.getBoundingClientRect().width)
      setPanelStyle((prev) => (prev.left === left ? prev : { ...prev, left }))
    })
  }

  const openPanel = () => {
    if (disabled) return
    const el = triggerRef.current
    const r = el?.getBoundingClientRect()
    setPanelStyle(r ? styleFromTriggerRect(r) : { position: 'fixed', zIndex: 80 })
    setOpen(true)
    setQuery('')
    setHighlight(0)
  }

  const pick = (next: string) => {
    onChange(next)
    close()
  }

  useLayoutEffect(() => {
    if (!open) return
    updatePanelPosition()
    const onReposition = () => updatePanelPosition()
    window.addEventListener('resize', onReposition)
    window.addEventListener('scroll', onReposition, true)
    return () => {
      window.removeEventListener('resize', onReposition)
      window.removeEventListener('scroll', onReposition, true)
    }
  }, [open, filtered])

  useEffect(() => {
    if (!open) return
    const t = window.setTimeout(() => searchRef.current?.focus(), 0)
    return () => window.clearTimeout(t)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node
      if (rootRef.current?.contains(t) || panelRef.current?.contains(t)) return
      close()
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  useEffect(() => {
    setHighlight((h) => (filtered.length === 0 ? 0 : Math.min(h, filtered.length - 1)))
  }, [filtered.length])

  const onKeyDown = (e: KeyboardEvent) => {
    if (disabled) return
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault()
        openPanel()
      }
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlight((h) => Math.min(h + 1, Math.max(0, filtered.length - 1)))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight((h) => Math.max(h - 1, 0))
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const opt = filtered[highlight]
      if (opt) pick(opt.value)
    }
  }

  return (
    <div
      ref={rootRef}
      className={`searchable-select${open ? ' is-open' : ''}${disabled ? ' is-disabled' : ''}${className ? ` ${className}` : ''}`}
      title={title}
      onKeyDown={onKeyDown}
    >
      <button
        ref={triggerRef}
        type="button"
        className="searchable-select-trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => (open ? close() : openPanel())}
      >
        <span
          className={`searchable-select-value${!selected && !(value === '' && emptyLabel != null) ? ' is-placeholder' : ''}`}
        >
          {displayLabel}
        </span>
        <span className="searchable-select-caret" aria-hidden>
          ▾
        </span>
      </button>

      {open ? (
        <div
          ref={panelRef}
          className="searchable-select-panel"
          role="presentation"
          style={panelStyle}
        >
          <input
            ref={searchRef}
            type="text"
            className="searchable-select-search"
            value={query}
            placeholder="Search…"
            spellCheck={false}
            aria-autocomplete="list"
            aria-controls={listId}
            onChange={(e) => {
              setQuery(e.target.value)
              setHighlight(0)
            }}
          />
          <ul id={listId} className="searchable-select-options" role="listbox">
            {filtered.length === 0 ? (
              <li className="searchable-select-empty">No matches</li>
            ) : (
              filtered.map((opt, i) => {
                const active = opt.value === value
                return (
                  <li key={`${opt.value || '__empty'}::${opt.label}`}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={active}
                      className={`searchable-select-option${active ? ' is-active' : ''}${i === highlight ? ' is-highlight' : ''}`}
                      onMouseEnter={() => setHighlight(i)}
                      onClick={() => pick(opt.value)}
                    >
                      {opt.label}
                    </button>
                  </li>
                )
              })
            )}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
