import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Button, FieldLabel, Input, Sheet, Textarea, useSnackbar } from '../../components/ui'
import { parseDateTime } from '../../lib/datetime'
import { formatPhoneBR } from '../../lib/format'
import { invalidateAll } from '../../lib/queries'
import { messageOf, RpcError, rpc, supabase } from '../../lib/rpc'
import { useClientRow } from '../../lib/clientQueries'

const ALREADY_MS = 10_000

/** Novo cliente: rpc_upsert_client. An existing match (created more than 10s ago) opens as "já cadastrada". */
export function NewClientSheet({ open, onClose, onOpenClient }: { open: boolean; onClose: () => void; onOpenClient: (id: string) => void }) {
  return (
    <Sheet open={open} onClose={onClose} kicker="Clientes" title="Novo cliente">
      {open && <NewForm onClose={onClose} onOpenClient={onOpenClient} />}
    </Sheet>
  )
}

function NewForm({ onClose, onOpenClient }: { onClose: () => void; onOpenClient: (id: string) => void }) {
  const qc = useQueryClient()
  const snack = useSnackbar()
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [birthday, setBirthday] = useState('')
  const [notes, setNotes] = useState('')
  const [pending, setPending] = useState(false)

  async function save() {
    setPending(true)
    try {
      const id = await rpc.upsertClient({
        p_name: name.trim(),
        p_phone: phone.trim() || null,
        p_external_code: null,
        p_birthday: birthday || null,
        p_notes: notes.trim() || null,
      })
      const { data } = await supabase.from('clients').select('created_at').eq('id', id).maybeSingle()
      const created = parseDateTime(data?.created_at)
      const existed = !!created && Date.now() - created.getTime() > ALREADY_MS
      invalidateAll(qc)
      if (existed) snack.show('Cliente já cadastrada')
      onClose()
      onOpenClient(id)
    } catch (e) {
      snack.show(messageOf(e), 'error')
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <FieldLabel htmlFor="nc-name">Nome</FieldLabel>
        <Input id="nc-name" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div>
        <FieldLabel htmlFor="nc-phone">Telefone</FieldLabel>
        <Input id="nc-phone" type="tel" inputMode="tel" placeholder="(11) 90000-0000" value={phone} onChange={(e) => setPhone(e.target.value)} />
      </div>
      <div>
        <FieldLabel htmlFor="nc-bday">Aniversário</FieldLabel>
        <Input id="nc-bday" type="date" value={birthday} onChange={(e) => setBirthday(e.target.value)} />
      </div>
      <div>
        <FieldLabel htmlFor="nc-notes">Notas</FieldLabel>
        <Textarea id="nc-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
      <Button block loading={pending} disabled={name.trim().length < 2} onClick={() => void save()}>
        Salvar cliente
      </Button>
    </div>
  )
}

/** Editar cliente: rpc_update_client. Shows INVALID_PHONE and DUPLICATE_CLIENT (with a link to the existing client). */
export function EditClientSheet({ clientId, open, onClose }: { clientId: string; open: boolean; onClose: () => void }) {
  const row = useClientRow(open ? clientId : undefined)
  return (
    <Sheet open={open} onClose={onClose} kicker="Cliente" title="Editar cliente">
      {open && row.data && <EditForm client={row.data} onClose={onClose} />}
    </Sheet>
  )
}

type ClientData = NonNullable<ReturnType<typeof useClientRow>['data']>

function EditForm({ client, onClose }: { client: ClientData; onClose: () => void }) {
  const qc = useQueryClient()
  const snack = useSnackbar()
  const [name, setName] = useState(client.name)
  const [phone, setPhone] = useState(client.phone_e164 ? formatPhoneBR(client.phone_e164, '') : '')
  const [birthday, setBirthday] = useState(client.birthday ?? '')
  const [notes, setNotes] = useState(client.notes ?? '')
  const [pending, setPending] = useState(false)
  const [phoneError, setPhoneError] = useState<string | null>(null)
  const [duplicateId, setDuplicateId] = useState<string | null>(null)

  async function save() {
    setPending(true)
    setPhoneError(null)
    setDuplicateId(null)
    try {
      await rpc.updateClient({
        p_client_id: client.id,
        p_name: name.trim(),
        p_phone: phone.trim() || null,
        p_birthday: birthday || null,
        p_notes: notes.trim() || null,
        p_archived: null,
      })
      invalidateAll(qc)
      snack.show('Cliente atualizada')
      onClose()
    } catch (e) {
      if (e instanceof RpcError && e.code === 'INVALID_PHONE') setPhoneError(e.message)
      else if (e instanceof RpcError && e.code === 'DUPLICATE_CLIENT') {
        setPhoneError(e.message)
        setDuplicateId(/id=([0-9a-f-]{36})/i.exec(e.detail ?? '')?.[1] ?? null)
      } else snack.show(messageOf(e), 'error')
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <FieldLabel htmlFor="ec-name">Nome</FieldLabel>
        <Input id="ec-name" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div>
        <FieldLabel htmlFor="ec-phone">Telefone</FieldLabel>
        <Input id="ec-phone" type="tel" inputMode="tel" placeholder="(11) 90000-0000" value={phone} onChange={(e) => setPhone(e.target.value)} />
        {phoneError && (
          <p role="alert" className="mt-2 text-sm !text-danger">
            {phoneError}
            {duplicateId && (
              <>
                {' '}
                <Link to={`/clientes/${duplicateId}`} onClick={onClose} className="underline">
                  Abrir cliente existente
                </Link>
              </>
            )}
          </p>
        )}
      </div>
      <div>
        <FieldLabel htmlFor="ec-bday">Aniversário</FieldLabel>
        <Input id="ec-bday" type="date" value={birthday} onChange={(e) => setBirthday(e.target.value)} />
      </div>
      <div>
        <FieldLabel htmlFor="ec-notes">Notas</FieldLabel>
        <Textarea id="ec-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
      <Button block loading={pending} disabled={name.trim().length < 2} onClick={() => void save()}>
        Salvar
      </Button>
    </div>
  )
}
