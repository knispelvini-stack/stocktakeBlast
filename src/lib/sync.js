// Offline-first sync engine.
//
// Every scan is written to IndexedDB first (outbox) and answered instantly from
// the local unit cache. A background loop pushes the outbox to sync_events()
// in batches, applies the server's authoritative answers, and records anything
// surprising in "attention". Each event has a client UUID that becomes the
// server row id, so retries are safe.
//
// Dependencies are injected so this runs in Node tests (fake-indexeddb).

import { ALL_STORES } from './localdb.js'
import { normalizeCode } from './scanDetector.js'
import { predictMove, predictScan, computeSummary, needsAttention, isRetryable, isAuthError } from './predict.js'

const BATCH = 100
const HISTORY_CACHE_PER_ORG = 1000

export function createSyncEngine({
  db,
  rpc, // (name, args) => Promise<{ data, error, status }>
  refreshAuth = async () => false,
  uuid = () => crypto.randomUUID(),
  now = () => new Date(),
  isOnline = () => (typeof navigator === 'undefined' ? true : navigator.onLine),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = t => clearTimeout(t),
}) {
  let ctx = { userId: null, label: null }
  let state = {
    online: isOnline(),
    syncing: false,
    pending: 0,
    attention: 0,
    lastSyncAt: null,
    lastError: null,
    version: 0, // bumps on any local data change → screens re-read
  }
  const listeners = new Set()
  const resultListeners = new Set()
  let flushing = false
  let flushAgain = false
  let failures = 0
  let timer = null
  let seq = Date.now() * 1000

  // ───────── state ─────────
  function set(patch) {
    state = { ...state, ...patch }
    listeners.forEach(l => l())
  }
  function bump() {
    set({ version: state.version + 1 })
  }
  async function refreshCounts() {
    const pending = ctx.userId ? await db.countFromIndex('outbox', 'user', ctx.userId) : 0
    const attention = await db.count('attention')
    set({ pending, attention })
  }

  // ───────── scheduling ─────────
  function schedule(ms) {
    if (timer) clearTimer(timer)
    timer = setTimer(() => {
      timer = null
      flush()
    }, ms)
  }
  function backoff() {
    failures++
    schedule(Math.min(60_000, 2000 * 2 ** (failures - 1)))
  }

  // ───────── recording (works offline) ─────────
  async function recordMove({ orgId, code: raw, direction, reference }) {
    const code = normalizeCode(raw)
    const tx = db.transaction(['units', 'outbox'], 'readwrite')
    const unit = await tx.objectStore('units').index('org_code').get([orgId, code])
    const pred = predictMove(unit, direction)
    const ev = {
      client_id: uuid(),
      kind: 'move',
      user_id: ctx.userId,
      org_id: orgId,
      code,
      direction,
      reference: reference?.trim() || null,
      scanned_at: now().toISOString(),
      seq: ++seq,
      predicted: pred.result,
      product: unit?.product ?? null,
    }
    await tx.objectStore('outbox').put(ev)
    if (pred.result === 'ok') {
      await tx.objectStore('units').put({ ...unit, status: pred.status, last_moved_at: ev.scanned_at })
    }
    await tx.done
    await afterRecord()
    return { ...pred, code, product: unit?.product ?? null, client_id: ev.client_id }
  }

  async function recordScan({ orgId, sessionId, code: raw }) {
    const code = normalizeCode(raw)
    const tx = db.transaction(['units', 'scans', 'outbox', 'sessions'], 'readwrite')
    const session = await tx.objectStore('sessions').get(sessionId)
    if (!session || session.status !== 'open') {
      tx.abort()
      await tx.done.catch(() => {})
      return { result: 'session_closed', code }
    }
    const unit = await tx.objectStore('units').index('org_code').get([orgId, code])
    const sessionScans = await tx.objectStore('scans').index('session').getAll(sessionId)
    const pred = predictScan(unit, sessionScans)
    const id = uuid()
    const at = now().toISOString()
    await tx.objectStore('scans').put({
      id,
      session_id: sessionId,
      org_id: orgId,
      code,
      unit_id: unit?.id ?? null,
      result: pred.result,
      scanned_at: at,
      pending: true,
    })
    await tx.objectStore('outbox').put({
      client_id: id,
      kind: 'scan',
      user_id: ctx.userId,
      org_id: orgId,
      session_id: sessionId,
      code,
      scanned_at: at,
      seq: ++seq,
      predicted: pred.result,
      product: unit?.product ?? null,
    })
    await tx.done
    await afterRecord()
    return { ...pred, code, product: unit?.product ?? null, client_id: id }
  }

  async function createSession({ orgId, name }) {
    const id = uuid()
    const at = now().toISOString()
    const tx = db.transaction(['sessions', 'outbox'], 'readwrite')
    await tx.objectStore('sessions').put({ id, org_id: orgId, name, status: 'open', created_at: at, pending: true })
    await tx.objectStore('outbox').put({
      client_id: id,
      kind: 'session',
      user_id: ctx.userId,
      org_id: orgId,
      name,
      scanned_at: at,
      seq: ++seq,
      predicted: 'ok',
    })
    await tx.done
    await afterRecord()
    return id
  }

  async function afterRecord() {
    bump()
    await refreshCounts()
    schedule(0)
  }

  // ───────── pushing ─────────
  function toWire(ev) {
    const { client_id, kind, org_id, code, direction, reference, session_id, name, scanned_at } = ev
    return { client_id, kind, org_id, code, direction, reference, session_id, name, scanned_at }
  }

  async function flush() {
    if (!ctx.userId) return
    if (flushing) {
      flushAgain = true
      return
    }
    if (!isOnline()) {
      set({ online: false })
      schedule(15_000)
      return
    }
    flushing = true
    set({ syncing: true })
    let refreshed = false
    try {
      for (;;) {
        const all = await db.getAllFromIndex('outbox', 'user', ctx.userId)
        if (!all.length) break
        all.sort((a, b) => a.scanned_at.localeCompare(b.scanned_at) || a.seq - b.seq)
        const batch = all.slice(0, BATCH)

        const { data, error, status } = await rpc('sync_events', { p_events: batch.map(toWire) })
        if (error) {
          if (isAuthError(error, status) && !refreshed) {
            refreshed = true
            if (await refreshAuth()) continue
          }
          if (isRetryable(error, status)) set({ online: false })
          set({ lastError: error.message })
          backoff()
          return
        }
        failures = 0
        await applyResults(batch, data)
        set({ online: true, lastSyncAt: now().toISOString(), lastError: null })
      }
    } catch (e) {
      set({ lastError: String(e?.message || e) })
      backoff()
    } finally {
      flushing = false
      set({ syncing: false })
      await refreshCounts()
      if (flushAgain) {
        flushAgain = false
        schedule(0)
      }
    }
  }

  async function applyResults(batch, results) {
    const byId = new Map(results.map(r => [r.client_id, r]))
    const tx = db.transaction(['outbox', 'units', 'scans', 'sessions', 'history', 'attention'], 'readwrite')
    const emitted = []
    for (const ev of batch) {
      const res = byId.get(ev.client_id)
      if (!res) continue // not processed: stays in outbox for the next round
      await tx.objectStore('outbox').delete(ev.client_id)

      if (ev.kind === 'move') {
        if (res.unit_id && res.status) {
          const unit = await tx.objectStore('units').get(res.unit_id)
          if (unit) await tx.objectStore('units').put({ ...unit, status: res.status })
        }
        if (res.result === 'ok' || res.result === 'late') {
          await tx.objectStore('history').put({
            id: ev.client_id,
            org_id: ev.org_id,
            code: ev.code,
            product: res.product ?? ev.product,
            direction: ev.direction,
            reference: ev.reference,
            applied: res.result === 'ok',
            scanned_at: ev.scanned_at,
            user_label: ctx.label,
          })
        }
      } else if (ev.kind === 'scan') {
        const scan = await tx.objectStore('scans').get(ev.client_id)
        await tx.objectStore('scans').put({
          ...(scan ?? { id: ev.client_id, session_id: ev.session_id, org_id: ev.org_id, code: ev.code, scanned_at: ev.scanned_at }),
          unit_id: res.unit_id ?? scan?.unit_id ?? null,
          result: res.result === 'session_closed' || res.result === 'error' ? 'rejected' : res.result,
          pending: false,
        })
      } else if (ev.kind === 'session') {
        const s = await tx.objectStore('sessions').get(ev.client_id)
        if (s) await tx.objectStore('sessions').put({ ...s, pending: res.result !== 'ok' })
      }

      if (needsAttention(ev.kind, ev.predicted, res)) {
        await tx.objectStore('attention').put({
          id: ev.client_id,
          org_id: ev.org_id,
          kind: ev.kind,
          code: ev.code ?? null,
          direction: ev.direction ?? null,
          product: res.product ?? ev.product ?? null,
          predicted: ev.predicted,
          result: res.result,
          message: res.message ?? null,
          scanned_at: ev.scanned_at,
        })
      }
      emitted.push({ client_id: ev.client_id, kind: ev.kind, predicted: ev.predicted, ...res })
    }
    await tx.done
    bump()
    emitted.forEach(r => resultListeners.forEach(l => l(r)))
  }

  // ───────── pulling (refresh the local cache) ─────────
  async function call(name, args) {
    const { data, error, status } = await rpc(name, args)
    if (error) {
      if (isRetryable(error, status)) set({ online: false })
      const err = new Error(error.message)
      err.retryable = isRetryable(error, status)
      throw err
    }
    set({ online: true })
    return data
  }

  async function pullUnits(orgId) {
    const all = []
    let after = null
    for (;;) {
      const page = await call('pull_units', { p_org: orgId, p_after: after, p_limit: 2000 })
      all.push(...page)
      if (page.length < 2000) break
      after = page[page.length - 1].code
    }
    const tx = db.transaction(['units', 'outbox', 'meta'], 'readwrite')
    const units = tx.objectStore('units')
    let cursor = await units.index('org').openCursor(orgId)
    while (cursor) {
      await cursor.delete()
      cursor = await cursor.continue()
    }
    const byCode = new Map()
    for (const u of all) {
      const row = { ...u, org_id: orgId }
      byCode.set(u.code, row)
    }
    // Re-apply this device's unsynced moves so the cache reflects them.
    const pending = (await tx.objectStore('outbox').getAll())
      .filter(e => e.kind === 'move' && e.org_id === orgId)
      .sort((a, b) => a.scanned_at.localeCompare(b.scanned_at) || a.seq - b.seq)
    for (const ev of pending) {
      const u = byCode.get(ev.code)
      const p = predictMove(u, ev.direction)
      if (p.result === 'ok') byCode.set(ev.code, { ...u, status: p.status })
    }
    for (const row of byCode.values()) await units.put(row)
    await tx.objectStore('meta').put(now().toISOString(), `unitsPulledAt:${orgId}`)
    await tx.done
    bump()
    return all.length
  }

  async function pullSessions(orgId) {
    const rows = await call('pull_sessions', { p_org: orgId })
    const tx = db.transaction('sessions', 'readwrite')
    for (const s of rows) await tx.store.put({ ...s, pending: false })
    await tx.done
    bump()
  }

  async function pullScans(sessionId) {
    const rows = await call('pull_scans', { p_session: sessionId })
    const tx = db.transaction('scans', 'readwrite')
    for (const s of rows) {
      const local = await tx.store.get(s.id)
      await tx.store.put({ ...local, ...s, pending: false })
    }
    await tx.done
    bump()
  }

  async function refreshOrg(orgId) {
    try {
      await flush()
      await Promise.all([pullUnits(orgId), pullSessions(orgId)])
      return true
    } catch (e) {
      if (!e.retryable) set({ lastError: e.message })
      return false
    }
  }

  async function loadOrgs(userId) {
    try {
      const orgs = await call('my_orgs', {})
      await db.put('meta', orgs, `orgs:${userId}`)
      return orgs
    } catch (e) {
      const cached = await db.get('meta', `orgs:${userId}`)
      if (cached && e.retryable) return cached
      throw e
    }
  }

  // ───────── local reads ─────────
  async function sessionSummary(orgId, sessionId) {
    const [units, scans] = await Promise.all([
      db.getAllFromIndex('units', 'org', orgId),
      db.getAllFromIndex('scans', 'session', sessionId),
    ])
    return computeSummary(units, scans)
  }

  async function listSessions(orgId) {
    const rows = await db.getAllFromIndex('sessions', 'org', orgId)
    return rows.sort((a, b) => b.created_at.localeCompare(a.created_at))
  }

  async function pendingEvents(orgId, kind) {
    const rows = ctx.userId ? await db.getAllFromIndex('outbox', 'user', ctx.userId) : []
    return rows
      .filter(e => e.org_id === orgId && (!kind || e.kind === kind))
      .sort((a, b) => b.scanned_at.localeCompare(a.scanned_at))
  }

  async function pendingForSession(sessionId) {
    const rows = ctx.userId ? await db.getAllFromIndex('outbox', 'user', ctx.userId) : []
    return rows.filter(e => e.session_id === sessionId || (e.kind === 'session' && e.client_id === sessionId)).length
  }

  async function listAttention(orgId) {
    const rows = await db.getAllFromIndex('attention', 'org', orgId)
    return rows.sort((a, b) => b.scanned_at.localeCompare(a.scanned_at))
  }

  async function dismissAttention(id) {
    await db.delete('attention', id)
    await refreshCounts()
    bump()
  }

  async function cacheHistory(orgId, rows) {
    const tx = db.transaction('history', 'readwrite')
    for (const r of rows) await tx.store.put({ ...r, org_id: orgId })
    await tx.done
    // prune to the newest N per org
    const all = await db.getAllFromIndex('history', 'org', orgId)
    if (all.length > HISTORY_CACHE_PER_ORG) {
      all.sort((a, b) => b.scanned_at.localeCompare(a.scanned_at))
      const tx2 = db.transaction('history', 'readwrite')
      for (const r of all.slice(HISTORY_CACHE_PER_ORG)) await tx2.store.delete(r.id)
      await tx2.done
    }
  }

  async function cachedHistory(orgId, f = {}) {
    const code = f.code ? normalizeCode(f.code) : null
    const ref = f.reference?.trim().toLowerCase()
    const rows = await db.getAllFromIndex('history', 'org', orgId)
    return rows
      .filter(
        r =>
          (!code || r.code === code) &&
          (!f.direction || r.direction === f.direction) &&
          (!ref || (r.reference || '').toLowerCase().includes(ref)) &&
          (!f.from || r.scanned_at >= f.from) &&
          (!f.to || r.scanned_at < f.to),
      )
      .sort((a, b) => b.scanned_at.localeCompare(a.scanned_at))
  }

  async function markSessionClosed(sessionId) {
    const s = await db.get('sessions', sessionId)
    if (s) await db.put('sessions', { ...s, status: 'closed', closed_at: now().toISOString() })
    bump()
  }

  // ───────── lifecycle ─────────
  async function setUser(userId, label = null) {
    ctx = { userId, label }
    await refreshCounts()
    if (userId) schedule(0)
  }

  async function clearAll() {
    const tx = db.transaction(ALL_STORES, 'readwrite')
    await Promise.all(ALL_STORES.map(s => tx.objectStore(s).clear()))
    await tx.done
    await refreshCounts()
    bump()
  }

  function start() {
    const onOnline = () => {
      set({ online: true })
      failures = 0
      schedule(0)
    }
    const onOffline = () => set({ online: false })
    const onVisible = () => document.visibilityState === 'visible' && schedule(0)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    document.addEventListener('visibilitychange', onVisible)
    const tick = setInterval(() => state.pending && !flushing && !timer && schedule(0), 20_000)
    return () => {
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
      document.removeEventListener('visibilitychange', onVisible)
      clearInterval(tick)
      if (timer) clearTimer(timer)
    }
  }

  return {
    // state
    subscribe(l) {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    getState: () => state,
    onResult(l) {
      resultListeners.add(l)
      return () => resultListeners.delete(l)
    },
    // actions
    setUser,
    start,
    flush,
    recordMove,
    recordScan,
    createSession,
    pullUnits,
    pullSessions,
    pullScans,
    refreshOrg,
    loadOrgs,
    markSessionClosed,
    clearAll,
    // reads
    sessionSummary,
    listSessions,
    pendingEvents,
    pendingForSession,
    listAttention,
    dismissAttention,
    cacheHistory,
    cachedHistory,
  }
}
