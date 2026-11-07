import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { TalkApp } from './TalkApp'

const root = document.getElementById('root')
if (root)
  createRoot(root).render(
    <StrictMode>
      <TalkApp />
    </StrictMode>,
  )
