import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'

// No screens yet (Task 1 is database core only).
createRoot(document.getElementById('root')!).render(<StrictMode>{null}</StrictMode>)
