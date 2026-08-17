import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@/styles/index.css'
import App from './App.tsx'

// After a deploy, a tab still running the old bundle 404s when it lazy-loads
// a chunk (the old hashed assets are gone). Vite signals this as
// vite:preloadError — reload once to pick up the new bundle instead of
// surfacing "Failed to fetch dynamically imported module" to the user.
// The timestamp guard prevents a reload loop if the fetch keeps failing.
window.addEventListener('vite:preloadError', (event) => {
  const last = Number(sessionStorage.getItem('chunk-reload-at') || 0)
  if (Date.now() - last < 60_000) return
  sessionStorage.setItem('chunk-reload-at', String(Date.now()))
  event.preventDefault()
  window.location.reload()
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
