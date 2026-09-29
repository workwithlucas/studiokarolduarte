import type { ReactNode } from 'react'

export function TabLabel({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`label-caps hit shrink-0 rounded-full px-4 transition-colors duration-200 ${
        active ? 'bg-ink !text-surface' : 'bg-transparent'
      }`}
    >
      {children}
    </button>
  )
}

export function TabList({ children }: { children: ReactNode }) {
  return (
    <div role="tablist" className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1">
      {children}
    </div>
  )
}
