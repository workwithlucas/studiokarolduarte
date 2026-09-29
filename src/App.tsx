import { Navigate, Route, Routes } from 'react-router-dom'
import { useAuth } from './auth/AuthContext'
import { Skeleton } from './components/ui'
import { AppLayout } from './layout/AppLayout'
import { AgendaPage } from './pages/AgendaPage'
import { CatalogPage } from './pages/CatalogPage'
import { HomePage } from './pages/HomePage'
import { LoginPage } from './pages/LoginPage'
import { TeamPage } from './pages/TeamPage'
import { UnauthorizedPage } from './pages/UnauthorizedPage'

function Guard() {
  const { loading, session, professional } = useAuth()
  if (loading) {
    return (
      <div className="mx-auto max-w-md space-y-3 p-8">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-32" />
      </div>
    )
  }
  if (!session) return <Navigate to="/login" replace />
  if (!professional) return <UnauthorizedPage />
  return <AppLayout />
}

function OwnerOnly({ children }: { children: React.ReactNode }) {
  const { isOwner } = useAuth()
  return isOwner ? <>{children}</> : <Navigate to="/" replace />
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<Guard />}>
        <Route index element={<HomePage />} />
        <Route path="agenda" element={<AgendaPage />} />
        <Route path="catalogo" element={<CatalogPage />} />
        <Route
          path="equipe"
          element={
            <OwnerOnly>
              <TeamPage />
            </OwnerOnly>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
