import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@/styles/index.css'
import { installStaleChunkGuard } from '@/lib/app-version'
import App from './App.tsx'

// After a deploy, a tab still running the old bundle 404s when it lazy-loads
// a chunk (the old hashed assets are gone). Vite signals this as
// vite:preloadError.
//
// Until 2026-09-20 this reloaded the tab on the spot. That was the wrong
// trade and it was made without knowing the price: EditorRoom holds the
// manuscript, the paid-for editorial pass and every accept/decline ruling in
// React state and writes none of it anywhere, the Assistant's conversation
// and unsent question are equally unpersisted, and a Page saves on blur
// alone. An unprompted reload threw all of that away, and a Vercel deploy —
// which happens on every merge — could trigger it while someone was typing.
//
// So it says so instead. installStaleChunkGuard puts one dismissible line in
// the shell's banner ("This tab is out of date — refresh to continue.") with
// a Refresh button, and the person chooses the moment. It does not
// preventDefault: a prevented vite:preloadError makes the failing import()
// resolve undefined, and the caller then dies on a destructure that names
// nothing. Letting it reject keeps the error next to the button that was
// pressed.
installStaleChunkGuard()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
