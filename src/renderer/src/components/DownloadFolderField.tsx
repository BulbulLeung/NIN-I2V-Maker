import { FieldHintIcon } from './FieldHintIcon'

interface Props {
  value: string
  onChange: (value: string) => void
  disabled?: boolean
}

export function DownloadFolderField({ value, onChange, disabled = false }: Props) {
  const browse = async () => {
    const dir = await window.api.openFolder()
    if (!dir) return
    onChange(dir)
  }

  const useDefault = async () => {
    const path = await window.api.defaultDownloadFolder()
    onChange(path)
  }

  return (
    <label className="field">
      <span>
        Download folder
        <FieldHintIcon title="Download folder">
          Shared by Python install and ComfyUI downloads. Uses <code>{'{folder}'}/python</code> and{' '}
          <code>{'{folder}'}/models</code>. Empty defaults to{' '}
          <code>AppData\Roaming\NIN I2V Maker</code>.
        </FieldHintIcon>
      </span>
      <div className="model-row">
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Empty = AppData\Roaming\NIN I2V Maker"
          spellCheck={false}
          disabled={disabled}
        />
        <button type="button" onClick={() => void browse()} disabled={disabled}>
          Browse
        </button>
        <button type="button" onClick={() => void useDefault()} disabled={disabled}>
          Default
        </button>
      </div>
    </label>
  )
}
