import { useAuth } from '../auth/AuthContext'
import { Button, EmptyState } from '../components/ui'

export function UnauthorizedPage() {
  const { signOut } = useAuth()
  return (
    <div className="mx-auto flex min-h-dvh max-w-md items-center px-4">
      <EmptyState
        title="Acesso não autorizado"
        help="Este usuário não está vinculado a uma profissional ativa do studio."
        action={<Button onClick={() => void signOut()}>Sair</Button>}
      />
    </div>
  )
}
