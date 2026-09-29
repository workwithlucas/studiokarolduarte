import { formatBRL } from '../../lib/money'
import { Input } from './Input'

/** BRL input backed by integer cents: typing digits fills from the right. */
export function MoneyInput({
  value,
  onChange,
  id,
  disabled,
}: {
  value: number | null
  onChange: (cents: number | null) => void
  id?: string
  disabled?: boolean
}) {
  return (
    <Input
      id={id}
      inputMode="numeric"
      disabled={disabled}
      placeholder="R$ 0,00"
      value={value === null ? '' : formatBRL(value)}
      onChange={(e) => {
        const digits = e.target.value.replace(/\D/g, '').slice(0, 9)
        onChange(digits === '' ? null : Number(digits))
      }}
    />
  )
}
