import { Bot, CalendarDays, Home, LogOut, MoreHorizontal, Package, Sparkles, UserRound, Users } from 'lucide-react'
import { useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { Sheet } from '../components/ui'

export function AppLayout() {
  const { isOwner, signOut, professional } = useAuth()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const [moreOpen, setMoreOpen] = useState(false)

  const main = [
    { to: '/', label: 'Início', icon: Home, end: true },
    { to: '/agenda', label: 'Agenda', icon: CalendarDays },
    { to: '/clientes', label: 'Clientes', icon: UserRound },
  ]
  const more = [
    { to: '/catalogo', label: 'Catálogo', icon: Sparkles },
    { to: '/pacotes', label: 'Pacotes', icon: Package },
    ...(isOwner ? [{ to: '/agente', label: 'Agente', icon: Bot }, { to: '/equipe', label: 'Equipe', icon: Users }] : []),
  ]
  const sidebar: Array<{ to: string; label: string; icon: typeof Home; end?: boolean }> = [...main, ...more]
  const moreActive = more.some((m) => pathname.startsWith(m.to))

  return (
    <div className="min-h-dvh lg:flex">
      <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col border-r border-line bg-surface/70 p-6 lg:flex">
        <p className="title-serif mb-8 text-2xl">Studio Karol Duarte</p>
        <nav className="flex flex-1 flex-col gap-1">
          {sidebar.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `label-caps hit flex items-center gap-3 rounded-full px-4 transition-colors duration-200 ${
                  isActive ? 'bg-ink !text-surface' : ''
                }`
              }
            >
              <Icon size={18} />
              {label}
            </NavLink>
          ))}
        </nav>
        <p className="text-help mb-2 truncate">{professional?.name}</p>
        <button type="button" onClick={() => void signOut()} className="label-caps hit flex items-center gap-3 rounded-full px-4">
          <LogOut size={18} />
          Sair
        </button>
      </aside>

      <div className="min-w-0 flex-1 pb-[calc(6rem+env(safe-area-inset-bottom))] lg:pb-0">
        <header className="flex items-center justify-between px-4 pb-0 pt-[max(1rem,env(safe-area-inset-top))] lg:hidden">
          <p className="title-serif text-lg">Studio Karol Duarte</p>
          <button type="button" aria-label="Sair" onClick={() => void signOut()} className="hit inline-flex items-center justify-center rounded-full">
            <LogOut size={20} />
          </button>
        </header>
        <main className="mx-auto w-full max-w-6xl px-4 py-5 lg:px-8 lg:py-8">
          <Outlet />
        </main>
      </div>

      <nav className="fixed inset-x-0 bottom-0 z-40 flex justify-around border-t border-line bg-surface px-2 pb-[env(safe-area-inset-bottom)] lg:hidden">
        {main.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              `label-caps hit flex flex-1 flex-col items-center justify-center gap-1 py-2 ${isActive ? '!text-ink' : ''}`
            }
          >
            <Icon size={20} />
            {label}
          </NavLink>
        ))}
        <button
          type="button"
          onClick={() => setMoreOpen(true)}
          className={`label-caps hit flex flex-1 flex-col items-center justify-center gap-1 py-2 ${moreActive ? '!text-ink' : ''}`}
        >
          <MoreHorizontal size={20} />
          Mais
        </button>
      </nav>

      <Sheet open={moreOpen} onClose={() => setMoreOpen(false)} title="Mais">
        <ul className="space-y-2">
          {more.map(({ to, label, icon: Icon }) => (
            <li key={to}>
              <button
                type="button"
                onClick={() => {
                  setMoreOpen(false)
                  navigate(to)
                }}
                className="hit flex w-full items-center gap-3 rounded-[var(--radius-input)] border border-line px-4 text-left"
              >
                <Icon size={18} />
                <span className="title-serif text-lg">{label}</span>
              </button>
            </li>
          ))}
        </ul>
      </Sheet>
    </div>
  )
}
