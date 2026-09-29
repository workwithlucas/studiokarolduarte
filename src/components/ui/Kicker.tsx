import type { ReactNode } from 'react'

export function Kicker({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <p className={`label-caps ${className}`}>{children}</p>
}
