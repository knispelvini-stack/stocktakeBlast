import { openDB } from 'idb'

// Everything the app needs to keep working offline lives here.
//   units      cached copy of the org's units (+ product name) for instant lookups
//   outbox     events recorded on this device and not yet confirmed by the server
//   sessions   stocktake sessions (server + created offline)
//   scans      stocktake scans (server + pending local ones)
//   history    recent movements, for the History screen when offline
//   attention  sync results a human should look at (conflicts, errors)
//   meta       misc key/value (cached org list, last pull times)
export function openLocalDb(name = 'stocktakeblast') {
  return openDB(name, 1, {
    upgrade(db) {
      const units = db.createObjectStore('units', { keyPath: 'id' })
      units.createIndex('org_code', ['org_id', 'code'])
      units.createIndex('org', 'org_id')

      const outbox = db.createObjectStore('outbox', { keyPath: 'client_id' })
      outbox.createIndex('user', 'user_id')

      const sessions = db.createObjectStore('sessions', { keyPath: 'id' })
      sessions.createIndex('org', 'org_id')

      const scans = db.createObjectStore('scans', { keyPath: 'id' })
      scans.createIndex('session', 'session_id')

      const history = db.createObjectStore('history', { keyPath: 'id' })
      history.createIndex('org', 'org_id')

      const attention = db.createObjectStore('attention', { keyPath: 'id' })
      attention.createIndex('org', 'org_id')

      db.createObjectStore('meta')
    },
  })
}

export const ALL_STORES = ['units', 'outbox', 'sessions', 'scans', 'history', 'attention', 'meta']
