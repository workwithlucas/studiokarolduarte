import type { ReactNode } from 'react'

export function Chip({
  selected,
  onClick,
  children,
  dot,
  disabled,
}: {
  selected?: boolean
  onClick?: () => void
  children: ReactNode
  dot?: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      onClick={onClick}
      className={`label-caps hit inline-flex items-center gap-2 rounded-full border px-4 transition-colors duration-200 disabled:opacity-40 ${
        selected ? 'border-transparent bg-ink !text-surface' : 'border-line bg-surface'
      }`}
    >
      {dot && <span className="size-2.5 rounded-full" style={{ backgroundColor: dot }} />}
      {children}
    </button>
  )
}

export function ChipRow({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap gap-2">{children}</div>
}
