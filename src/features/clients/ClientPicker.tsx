import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Input } from '../../components/ui'
import { formatPhoneBR, toTitlePt } from '../../lib/format'
import { rpc } from '../../lib/rpc'
import { useDebounced } from './common'

export interface PickedClient {
  id: string
  name: string
  phone: string | null
}

/** Accent-insensitive client search (rpc_search_clients). Shows up to 8 matches. */
export function ClientPicker({ onPick, placeholder = 'Buscar por nome ou telefone' }: { onPick: (c: PickedClient) => void; placeholder?: string }) {
  const [term, setTerm] = useState('')
  const debounced = useDebounced(term.trim(), 250)
  const search = useQuery({
    queryKey: ['clients-search', 'picker', debounced],
    enabled: debounced.length >= 2,
    queryFn: () => rpc.searchClients({ p_query: debounced, p_filter: 'all', p_limit: 8, p_offset: 0 }),
  })

  return (
    <div className="space-y-2">
      <Input placeholder={placeholder} value={term} onChange={(e) => setTerm(e.target.value)} />
      {(search.data ?? []).map((c) => (
        <button
          key={c.client_id}
          type="button"
          onClick={() => onPick({ id: c.client_id, name: c.name, phone: c.phone_e164 })}
          className="hit flex w-full items-center justify-between gap-3 rounded-[var(--radius-input)] border border-line px-4 text-left"
        >
          <span className="title-serif text-lg">{toTitlePt(c.name)}</span>
          <span className="text-help">{formatPhoneBR(c.phone_e164)}</span>
        </button>
      ))}
      {search.data && search.data.length === 0 && debounced.length >= 2 && <p className="text-help">Nenhuma cliente encontrada.</p>}
    </div>
  )
}
