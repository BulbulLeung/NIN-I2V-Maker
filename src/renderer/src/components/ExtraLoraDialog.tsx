import type { ExtraLoraEntry } from '../types'
import { createExtraLoraEntry } from '../defaults/i2vGenerate'
import { basenamePath } from '../services/comfyI2v'
import { splitModelsByHighLow } from '../utils/highLowModelSplit'
import { SearchableSelect } from './SearchableSelect'

interface ModelFile {
  name: string
  path: string
}

interface Props {
  open: boolean
  models: ModelFile[]
  folderSet: boolean
  highLoras: ExtraLoraEntry[]
  lowLoras: ExtraLoraEntry[]
  onChangeHigh: (entries: ExtraLoraEntry[]) => void
  onChangeLow: (entries: ExtraLoraEntry[]) => void
  onClose: () => void
}

function LoraColumn({
  title,
  entries,
  models,
  folderSet,
  onChange
}: {
  title: string
  entries: ExtraLoraEntry[]
  models: ModelFile[]
  folderSet: boolean
  onChange: (entries: ExtraLoraEntry[]) => void
}) {
  const add = () => onChange([...entries, createExtraLoraEntry()])
  const update = (id: string, partial: Partial<ExtraLoraEntry>) => {
    onChange(entries.map((e) => (e.id === id ? { ...e, ...partial } : e)))
  }
  const remove = (id: string) => onChange(entries.filter((e) => e.id !== id))

  return (
    <section className="lora-popup-column">
      <div className="lora-popup-column-head">
        <h3>{title}</h3>
        <button type="button" disabled={!folderSet} onClick={add}>
          Add
        </button>
      </div>
      {!folderSet ? (
        <p className="field-hint">Set Wan22 LoRA folder in Settings.</p>
      ) : null}
      {entries.length === 0 ? (
        <p className="field-hint">No LoRAs — click Add.</p>
      ) : (
        <ul className="lora-popup-list">
          {entries.map((entry) => {
            const known = models.some((m) => m.path === entry.path)
            return (
              <li
                key={entry.id}
                className={`lora-popup-row${entry.enabled === false ? ' is-off' : ''}`}
              >
                <button
                  type="button"
                  role="switch"
                  className={`lora-popup-switch${entry.enabled !== false ? ' on' : ''}`}
                  aria-checked={entry.enabled !== false}
                  title={entry.enabled !== false ? 'On' : 'Off'}
                  onClick={() =>
                    update(entry.id, { enabled: entry.enabled === false })
                  }
                >
                  <span className="lora-popup-switch-knob" />
                  <span className="lora-popup-switch-label">
                    {entry.enabled !== false ? 'On' : 'Off'}
                  </span>
                </button>
                <SearchableSelect
                  value={known ? entry.path : entry.path ? entry.path : ''}
                  disabled={models.length === 0 || entry.enabled === false}
                  placeholder={models.length === 0 ? 'No LoRAs in folder' : 'Select LoRA…'}
                  options={[
                    ...(!known && entry.path
                      ? [{ value: entry.path, label: `${basenamePath(entry.path)} (not in folder)` }]
                      : []),
                    ...models.map((m) => ({ value: m.path, label: m.name }))
                  ]}
                  onChange={(path) => update(entry.id, { path })}
                />
                <input
                  type="number"
                  className="lora-popup-weight"
                  value={entry.strength}
                  step={0.05}
                  min={0}
                  max={2}
                  title="Weight"
                  disabled={entry.enabled === false}
                  onChange={(e) => update(entry.id, { strength: Number(e.target.value) })}
                />
                <button
                  type="button"
                  className="danger lora-popup-remove"
                  title="Remove"
                  aria-label="Remove"
                  onClick={() => remove(entry.id)}
                >
                  ×
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

export function ExtraLoraDialog({
  open,
  models,
  folderSet,
  highLoras,
  lowLoras,
  onChangeHigh,
  onChangeLow,
  onClose
}: Props) {
  if (!open) return null

  const { high: highModels, low: lowModels } = splitModelsByHighLow(models)

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal modal-wide lora-popup-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Extra LoRAs"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="lora-popup-header">
          <h2>Extra LoRAs</h2>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="lora-popup-columns">
          <LoraColumn
            title="High noise LoRA"
            entries={highLoras}
            models={highModels}
            folderSet={folderSet}
            onChange={onChangeHigh}
          />
          <LoraColumn
            title="Low noise LoRA"
            entries={lowLoras}
            models={lowModels}
            folderSet={folderSet}
            onChange={onChangeLow}
          />
        </div>
      </div>
    </div>
  )
}
