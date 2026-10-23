import { MessageCircle } from 'lucide-react'
import { Suspense, lazy, useState } from 'react'

// Dynamic import: the chat (cards, query helpers) is a separate chunk, fetched the first time the button is used.
const AssistantSheet = lazy(() => import('./AssistantSheet'))

/** Floating button on every page. Rendered for the owner only (AppLayout). */
export function AssistantLauncher() {
  const [open, setOpen] = useState(false)
  const [used, setUsed] = useState(false)
  return (
    <>
      <button
        type="button"
        aria-label="Abrir o assistente financeiro"
        onClick={() => {
          setUsed(true)
          setOpen(true)
        }}
        className="fixed bottom-[calc(5.5rem+env(safe-area-inset-bottom))] right-4 z-50 inline-flex size-14 items-center justify-center rounded-full bg-primary-bg text-primary-ink shadow-[var(--shadow-card)] transition-transform duration-200 hover:scale-105 lg:bottom-8 lg:right-8"
      >
        <MessageCircle size={24} />
      </button>
      {used && (
        <Suspense fallback={null}>
          <AssistantSheet open={open} onClose={() => setOpen(false)} />
        </Suspense>
      )}
    </>
  )
}
