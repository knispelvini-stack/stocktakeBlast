import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import { UIProvider } from './components/ui/ui.jsx'
// Fonts are bundled (not Google Fonts) so the service worker caches them and a
// slow warehouse connection can't block the first render.
import '@fontsource/inter/latin-400.css'
import '@fontsource/inter/latin-500.css'
import '@fontsource/inter/latin-600.css'
import '@fontsource/inter/latin-700.css'
import '@fontsource/jetbrains-mono/latin-500.css'
import '@fontsource/jetbrains-mono/latin-700.css'
import './styles.css'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <UIProvider>
      <App />
    </UIProvider>
  </StrictMode>,
)

// Offline support: cache the app shell, and ask the browser not to evict our
// IndexedDB (unsynced scans live there) when the disk gets full.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js'))
}
navigator.storage?.persist?.().catch(() => {})
