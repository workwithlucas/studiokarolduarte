import { AnimatePresence, motion } from 'framer-motion'
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'

type Tone = 'info' | 'error'
interface Msg {
  id: number
  text: string
  tone: Tone
}

const Ctx = createContext<{ show: (text: string, tone?: Tone) => void }>({ show: () => {} })

export function SnackbarProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<Msg | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const seq = useRef(0)

  const show = useCallback((text: string, tone: Tone = 'info') => {
    window.clearTimeout(timer.current)
    setMsg({ id: ++seq.current, text, tone })
    timer.current = window.setTimeout(() => setMsg(null), 4500)
  }, [])
  const value = useMemo(() => ({ show }), [show])

  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-24 z-[70] flex justify-center px-4 lg:bottom-6">
        <AnimatePresence>
          {msg && (
            <motion.div
              key={msg.id}
              role="status"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 12 }}
              transition={{ duration: 0.2, ease: 'easeOut' }}
              className={`pointer-events-auto max-w-md rounded-full px-5 py-3 text-sm text-primary-ink shadow-card ${
                msg.tone === 'error' ? 'bg-danger' : 'bg-ink'
              }`}
            >
              {msg.text}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </Ctx.Provider>
  )
}

export function useSnackbar() {
  return useContext(Ctx)
}
