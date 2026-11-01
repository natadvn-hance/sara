// The pult's service worker (pult v2 design 6): a push carries no data; on waking it asks the core for the latest
// notice and shows it, silent in the quiet hours unless urgent. A tap opens the thing in the pult.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('push', (event) => {
  event.waitUntil(
    (async () => {
      let n = null
      try {
        const res = await fetch('/api/push/latest', { credentials: 'include', cache: 'no-store' })
        if (res.status === 200) n = await res.json()
      } catch {}
      const title = n?.title ?? 'Сара'
      await self.registration.showNotification(title, {
        body: n?.body ?? 'Новое в пульте',
        tag: n?.tag ?? 'sara',
        silent: n?.silent === true,
        icon: '/icon.svg',
        badge: '/icon.svg',
        data: { link: n?.link ?? '/notices' },
      })
    })(),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const link = event.notification.data?.link ?? '/'
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      const open = all.find((c) => new URL(c.url).origin === self.location.origin)
      if (open) {
        await open.focus()
        return open.navigate(link)
      }
      return self.clients.openWindow(link)
    })(),
  )
})
