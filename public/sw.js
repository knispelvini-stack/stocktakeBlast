// App-shell service worker: lets the app OPEN with no connection.
// Data never goes through here — Supabase calls are cross-origin and are
// left alone; offline data lives in IndexedDB (src/lib/localdb.js).
const CACHE = 'stb-shell-v1'

self.addEventListener('install', event => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE)
      const res = await fetch('/', { cache: 'no-store' })
      const html = await res.clone().text()
      await cache.put('/', res)
      // Vite emits hashed files under /assets — cache the ones this build uses.
      const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(m => m[1])
      await cache.addAll([...new Set(assets), '/manifest.webmanifest', '/icon.svg'])
      await self.skipWaiting()
    })(),
  )
})

self.addEventListener('activate', event => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key)
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', event => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return

  // Pages: network first (get new deploys), fall back to the cached shell.
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const res = await fetch(req)
          if (res.ok) (await caches.open(CACHE)).put('/', res.clone())
          return res
        } catch {
          return (await caches.match('/')) || Response.error()
        }
      })(),
    )
    return
  }

  // Hashed assets never change: cache first, then network (and remember it).
  event.respondWith(
    (async () => {
      const hit = await caches.match(req)
      if (hit) return hit
      const res = await fetch(req)
      if (res.ok && url.pathname.startsWith('/assets/')) (await caches.open(CACHE)).put(req, res.clone())
      return res
    })(),
  )
})
