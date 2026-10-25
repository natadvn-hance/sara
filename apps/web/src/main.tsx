import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { startTelegram } from './app/telegram'
import './design/tokens.css'
import './design/telegram.css'

// Before the first request: inside Telegram every request carries the signed launch data.
startTelegram()

const client = new QueryClient()
const root = document.getElementById('root')
if (root) {
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={client}>
        <App />
      </QueryClientProvider>
    </StrictMode>,
  )
}
