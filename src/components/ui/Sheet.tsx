import { AnimatePresence, motion } from 'framer-motion'
import { X } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

function useIsDesktop() {
  const q = '(min-width: 1024px)'
  const [v, setV] = useState(() => window.matchMedia(q).matches)
  useEffect(() => {
    const m = window.matchMedia(q)
    const on = () => setV(m.matches)
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [])
  return v
}

/** Bottom sheet below 1024px, side panel above. Children mount only while open, so their state resets. */
export function Sheet({
  open,
  onClose,
  title,
  kicker,
  children,
  footer,
}: {
  open: boolean
  onClose: () => void
  title: string
  kicker?: string
  children: ReactNode
  footer?: ReactNode
}) {
  const desktop = useIsDesktop()

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [open, onClose])

  const hidden = desktop ? { x: '100%' } : { y: '100%' }
  const shown = desktop ? { x: 0 } : { y: 0 }

  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[60]" role="dialog" aria-modal="true" aria-label={title}>
          <motion.div
            className="absolute inset-0 bg-ink/40"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            onPointerDown={onClose}
          />
          <motion.div
            className={`absolute flex flex-col bg-surface shadow-2xl ${
              desktop
                ? 'inset-y-0 right-0 w-[480px] max-w-full'
                : 'inset-x-0 bottom-0 max-h-[92dvh] rounded-t-[var(--radius-card)]'
            }`}
            initial={hidden}
            animate={shown}
            exit={hidden}
            transition={{ duration: 0.24, ease: 'easeOut' }}
          >
            <header className="flex items-start justify-between gap-3 border-b border-line px-5 pb-3 pt-5">
              <div>
                {kicker && <p className="label-caps mb-1">{kicker}</p>}
                <h2 className="title-serif text-2xl">{title}</h2>
              </div>
              <button type="button" aria-label="Fechar" onClick={onClose} className="hit inline-flex items-center justify-center rounded-full">
                <X size={22} />
              </button>
            </header>
            <div className="flex-1 overflow-y-auto px-5 py-5">{children}</div>
            {footer && <footer className="border-t border-line px-5 py-4">{footer}</footer>}
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  )
}
