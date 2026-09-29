import type { ReactNode } from 'react'

export function EmptyState({ title, help, action }: { title: string; help?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-[var(--radius-card)] border border-dashed border-line px-6 py-10 text-center">
      <p className="title-serif text-lg">{title}</p>
      {help && <p className="text-help max-w-sm">{help}</p>}
      {action}
    </div>
  )
}
