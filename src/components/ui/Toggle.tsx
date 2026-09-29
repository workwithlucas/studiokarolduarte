export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="hit inline-flex items-center justify-center disabled:opacity-50"
    >
      <span className={`relative h-7 w-12 rounded-full transition-colors duration-200 ${checked ? 'bg-success' : 'bg-line'}`}>
        <span
          className={`absolute top-1 size-5 rounded-full bg-surface shadow transition-all duration-200 ${
            checked ? 'left-6' : 'left-1'
          }`}
        />
      </span>
    </button>
  )
}
