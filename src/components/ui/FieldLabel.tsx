import type { ReactNode } from 'react'

export function FieldLabel({ children, htmlFor }: { children: ReactNode; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className="label-caps mb-2 block">
      {children}
    </label>
  )
}
