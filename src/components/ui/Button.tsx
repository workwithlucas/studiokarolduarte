import type { ButtonHTMLAttributes, ReactNode } from 'react'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-primary-bg text-primary-ink',
  secondary: 'border border-line bg-transparent text-ink',
  ghost: 'bg-transparent text-ink',
  danger: 'bg-danger text-primary-ink',
}

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  loading?: boolean
  icon?: ReactNode
  block?: boolean
}

export function Button({ variant = 'primary', loading, icon, block, disabled, className = '', children, ...rest }: Props) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`hit inline-flex items-center justify-center gap-2 rounded-full px-5 text-sm font-medium transition-opacity duration-200 disabled:opacity-50 ${
        block ? 'w-full' : ''
      } ${VARIANTS[variant]} ${className}`}
    >
      {icon}
      {loading ? 'Aguarde' : children}
    </button>
  )
}
