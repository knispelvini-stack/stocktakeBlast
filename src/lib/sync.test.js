import 'fake-indexeddb/auto'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openLocalDb } from './localdb.js'
import { createSyncEngine } from './sync.js'
import { computeSummary, needsAttention, isRetryable, predictMove } from './predict.js'

const ORG = 'org-1'
const OFFLINE = { data: null, error: { message: 'TypeError: Failed to fetch', code: '' }, status: 0 }
let dbn = 0

// Fake server: a tiny in-memory model of sync_events with the same rules.
function fakeServer(units) {
  const server = {
    online: true,
    units: new Map(units.map(u => [u.code, { ...u }])),
    seen: new Map(), // client_id → result (idempotency)
    calls: [],
    dropResponseOnce: false,
    authFailOnce: false,
    async rpc(name, args) {
      server.calls.push({ name, args })
      if (!server.online) return OFFLINE
      if (server.authFailOnce) {
        server.authFailOnce = false
        return { data: null, error: { message: 'JWT expired', code: 'PGRST301' }, status: 401 }
      }
      if (name === 'pull_units') {
        return { data: [...server.units.values()].map(u => ({ ...u })), error: null, status: 200 }
      }
      if (name === 'sync_events') {
        const out = args.p_events.map(ev => {
          if (server.seen.has(ev.client_id)) return { ...server.seen.get(ev.client_id), client_id: ev.client_id, replayed: true }
          let res
          if (ev.kind === 'move') {
            const u = server.units.get(ev.code)
            if (!u) res = { result: 'unknown' }
            else {
              const next = ev.direction === 'out' ? 'out' : 'in_stock'
              if (u.status === next) res = { result: 'already', unit_id: u.id, status: u.status, product: u.product }
              else if (u.last_moved_at && ev.scanned_at < u.last_moved_at)
                res = { result: 'late', unit_id: u.id, status: u.status, product: u.product }
              else {
                u.status = next
                u.last_moved_at = ev.scanned_at
                res = { result: 'ok', unit_id: u.id, status: next, product: u.product }
              }
            }
          } else res = { result: 'ok' }
          server.seen.set(ev.client_id, res)
          return { ...res, client_id: ev.client_id }
        })
        if (server.dropResponseOnce) {
          server.dropResponseOnce = false
          return OFFLINE // server applied it, but the response was lost
        }
        return { data: out, error: null, status: 200 }
      }
      return { data: [], error: null, status: 200 }
    },
  }
  return server
}

async function setup(units = [{ id: 'u1', code: 'AAAA1111', status: 'in_stock', product: 'Castle' }]) {
  const db = await openLocalDb(`test-${++dbn}`)
  const server = fakeServer(units)
  let clock = Date.parse('2026-11-17T10:00:00Z')
  const timers = []
  let refreshed = 0
  const engine = createSyncEngine({
    db,
    rpc: (n, a) => server.rpc(n, a),
    refreshAuth: async () => {
      refreshed++
      return true
    },
    now: () => new Date((clock += 1000)),
    isOnline: () => server.online,
    setTimer: fn => timers.push(fn), // manual: tests call flush() explicitly
    clearTimer: () => {},
  })
  await engine.setUser('user-1', 'a@example.com')
  await engine.pullUnits(ORG)
  return { db, server, engine, refreshed: () => refreshed }
}

test('offline move: instant prediction, cached status, queued', async () => {
  const { engine, server, db } = await setup()
  server.online = false
  const r = await engine.recordMove({ orgId: ORG, code: 'aaaa1111', direction: 'out', reference: 'Van 2' })
  assert.equal(r.result, 'ok')
  assert.equal(r.product, 'Castle')
  assert.equal((await db.get('units', 'u1')).status, 'out')
  await engine.flush()
  assert.equal(engine.getState().pending, 1)
  assert.equal(engine.getState().online, false)

  // second scan of the same unit while offline is predicted from the cache
  const r2 = await engine.recordMove({ orgId: ORG, code: 'AAAA1111', direction: 'out' })
  assert.equal(r2.result, 'already')
})

test('out reference is cached for the Overview and cleared on check-in', async () => {
  const { engine, server, db } = await setup()
  server.online = false
  await engine.recordMove({ orgId: ORG, code: 'AAAA1111', direction: 'out', reference: 'Van 2' })
  let u = await db.get('units', 'u1')
  assert.equal(u.last_ref, 'Van 2')
  assert.ok(u.out_since)
  assert.equal((await engine.listUnits(ORG)).length, 1)
  // a refresh from the server before sync keeps the pending reference
  server.online = true
  server.dropResponseOnce = false
  await engine.pullUnits(ORG)
  assert.equal((await db.get('units', 'u1')).last_ref, 'Van 2')
  await engine.recordMove({ orgId: ORG, code: 'AAAA1111', direction: 'in' })
  u = await db.get('units', 'u1')
  assert.equal(u.status, 'in_stock')
  assert.equal(u.last_ref, null)
})

test('vehicle: travels with the event, cached on the unit, cleared on check-in', async () => {
  const { engine, server, db } = await setup()
  server.online = false
  await engine.recordMove({ orgId: ORG, code: 'AAAA1111', direction: 'out', vehicleId: 'veh-2' })
  assert.equal((await db.get('units', 'u1')).vehicle_id, 'veh-2', 'offline: unit shows on the van at once')
  server.online = true
  await engine.flush()
  const sent = server.calls.find(c => c.name === 'sync_events').args.p_events[0]
  assert.equal(sent.vehicle_id, 'veh-2', 'vehicle sent to the server')
  assert.equal((await engine.cachedHistory(ORG))[0].vehicle_id, 'veh-2')
  await engine.recordMove({ orgId: ORG, code: 'AAAA1111', direction: 'in', vehicleId: 'veh-2' })
  assert.equal((await db.get('units', 'u1')).vehicle_id, null, 'back in stock: no longer on the van')
})

test('vehicles are cached for offline van-label scans', async () => {
  const { engine, server } = await setup()
  const orig = server.rpc
  server.rpc = async (n, a) => (n === 'pull_vehicles' ? { data: [{ id: 'veh-1', code: 'VEH-01', name: 'Van 1', active: true }], error: null, status: 200 } : orig(n, a))
  await engine.pullVehicles(ORG)
  server.online = false
  assert.equal((await engine.listVehicles(ORG))[0].code, 'VEH-01')
  server.rpc = orig
})

test('back online: outbox drains, history written, server status applied', async () => {
  const { engine, server, db } = await setup()
  server.online = false
  await engine.recordMove({ orgId: ORG, code: 'AAAA1111', direction: 'out', reference: 'Van 2' })
  server.online = true
  await engine.flush()
  assert.equal(engine.getState().pending, 0)
  assert.equal(server.units.get('AAAA1111').status, 'out')
  const hist = await engine.cachedHistory(ORG)
  assert.equal(hist.length, 1)
  assert.equal(hist[0].reference, 'Van 2')
  assert.equal(hist[0].applied, true)
  assert.equal((await engine.listAttention(ORG)).length, 0)
  assert.equal((await db.get('units', 'u1')).status, 'out')
})

test('lost response: same client_id is resent and not duplicated', async () => {
  const { engine, server } = await setup()
  await engine.recordMove({ orgId: ORG, code: 'AAAA1111', direction: 'out' })
  server.dropResponseOnce = true
  await engine.flush()
  assert.equal(engine.getState().pending, 1, 'still pending after lost response')
  await engine.flush()
  assert.equal(engine.getState().pending, 0)
  const sent = server.calls.filter(c => c.name === 'sync_events').map(c => c.args.p_events[0].client_id)
  assert.equal(sent.length, 2)
  assert.equal(sent[0], sent[1], 'retried with the same id')
  assert.equal((await engine.listAttention(ORG)).length, 0, 'replay of an ok is still ok')
})

test('conflict: older offline event comes back late → attention, status kept', async () => {
  const { engine, server, db } = await setup()
  server.online = false
  await engine.recordMove({ orgId: ORG, code: 'AAAA1111', direction: 'out' }) // scanned 10:00:0x
  // meanwhile another device checked it out and back in, later in time
  server.units.get('AAAA1111').status = 'in_stock'
  server.units.get('AAAA1111').last_moved_at = '2026-11-17T12:00:00Z'
  server.online = true
  await engine.flush()
  const att = await engine.listAttention(ORG)
  assert.equal(att.length, 1)
  assert.equal(att[0].result, 'late')
  assert.equal((await db.get('units', 'u1')).status, 'in_stock', 'cache corrected to server status')
  const hist = await engine.cachedHistory(ORG)
  assert.equal(hist[0].applied, false)
})

test('pullUnits keeps this device’s unsynced moves applied', async () => {
  const { engine, server, db } = await setup()
  server.online = false
  await engine.recordMove({ orgId: ORG, code: 'AAAA1111', direction: 'out' })
  server.online = true
  server.dropResponseOnce = false
  // pull happens before the flush (e.g. periodic refresh)
  const syncSpy = server.calls.length
  await engine.pullUnits(ORG)
  assert.equal(server.calls.length, syncSpy + 1)
  assert.equal((await db.get('units', 'u1')).status, 'out', 'pending OUT survives a refresh')
})

test('unknown offline code that exists on server is not flagged', async () => {
  const { engine, server } = await setup()
  server.units.set('NEWCODE1', { id: 'u2', code: 'NEWCODE1', status: 'in_stock', product: 'Slide' })
  const r = await engine.recordMove({ orgId: ORG, code: 'NEWCODE1', direction: 'out' })
  assert.equal(r.result, 'unknown')
  await engine.flush()
  assert.equal((await engine.listAttention(ORG)).length, 0)
  assert.equal(server.units.get('NEWCODE1').status, 'out')
})

test('expired token: refreshes and retries once', async () => {
  const { engine, server, refreshed } = await setup()
  await engine.recordMove({ orgId: ORG, code: 'AAAA1111', direction: 'out' })
  server.authFailOnce = true
  await engine.flush()
  assert.equal(refreshed(), 1)
  assert.equal(engine.getState().pending, 0)
})

test('events from another user on this device are not sent', async () => {
  const { engine, server } = await setup()
  await engine.recordMove({ orgId: ORG, code: 'AAAA1111', direction: 'out' })
  server.online = false
  await engine.flush()
  await engine.setUser('user-2')
  server.online = true
  await engine.flush()
  assert.equal(server.calls.filter(c => c.name === 'sync_events').length, 0)
  assert.equal(engine.getState().pending, 0, 'user-2 has nothing pending')
})

test('offline stocktake: session + scans, duplicate prediction, local summary', async () => {
  const { engine, server } = await setup([
    { id: 'u1', code: 'AAAA1111', status: 'in_stock', product: 'Castle' },
    { id: 'u2', code: 'BBBB2222', status: 'in_stock', product: 'Castle' },
    { id: 'u3', code: 'CCCC3333', status: 'out', product: 'Slide' },
  ])
  server.online = false
  const sid = await engine.createSession({ orgId: ORG, name: 'Nov' })
  assert.equal((await engine.recordScan({ orgId: ORG, sessionId: sid, code: 'AAAA1111' })).result, 'ok')
  assert.equal((await engine.recordScan({ orgId: ORG, sessionId: sid, code: 'AAAA1111' })).result, 'duplicate')
  assert.equal((await engine.recordScan({ orgId: ORG, sessionId: sid, code: 'cccc3333' })).unit_status, 'out')
  await engine.recordScan({ orgId: ORG, sessionId: sid, code: 'ZZZZ' })
  const s = await engine.sessionSummary(ORG, sid)
  assert.deepEqual(
    { expected: s.expected, matched: s.matched, missing: s.missing.map(m => m.code), extra: s.extra.map(e => e.code), unknown: s.unknown },
    { expected: 2, matched: 1, missing: ['BBBB2222'], extra: ['CCCC3333'], unknown: ['ZZZZ'] },
  )
  assert.equal(await engine.pendingForSession(sid), 5)

  server.online = true
  await engine.flush()
  const sent = server.calls.find(c => c.name === 'sync_events').args.p_events
  assert.equal(sent[0].kind, 'session', 'session is sent before its scans')
  assert.equal(await engine.pendingForSession(sid), 0)
})

test('stocktake: remove a wrong scan (unsynced → dropped; synced → voided, scan again counts)', async () => {
  const { engine, server } = await setup([
    { id: 'u1', code: 'AAAA1111', status: 'in_stock', product: 'Castle' },
    { id: 'u2', code: 'BBBB2222', status: 'in_stock', product: 'Castle' },
  ])
  server.online = false
  const sid = await engine.createSession({ orgId: ORG, name: 'Nov' })
  const a = await engine.recordScan({ orgId: ORG, sessionId: sid, code: 'AAAA1111' })
  assert.equal((await engine.unscan({ orgId: ORG, sessionId: sid, scanId: a.client_id })).result, 'removed')
  assert.equal((await engine.sessionSummary(ORG, sid)).matched, 0)
  assert.equal(await engine.pendingForSession(sid), 1, 'only the session itself is queued')

  server.online = true
  const b = await engine.recordScan({ orgId: ORG, sessionId: sid, code: 'BBBB2222' })
  await engine.flush()
  const u = await engine.unscan({ orgId: ORG, sessionId: sid, scanId: b.client_id })
  assert.equal(u.result, 'queued')
  assert.equal((await engine.sessionSummary(ORG, sid)).matched, 0, 'not counted any more')
  assert.equal((await engine.unscan({ orgId: ORG, sessionId: sid, scanId: b.client_id })).result, 'blocked', 'only once')
  await engine.flush()
  const sent = server.calls.filter(c => c.name === 'sync_events').at(-1).args.p_events[0]
  assert.deepEqual([sent.kind, sent.scan_id, sent.session_id], ['unscan', b.client_id, sid])
  const again = await engine.recordScan({ orgId: ORG, sessionId: sid, code: 'BBBB2222' })
  assert.equal(again.result, 'ok', 'scanning it again is not a duplicate')
  assert.equal((await engine.sessionSummary(ORG, sid)).matched, 1)
})

test('damaged condition travels with the local unit', async () => {
  const { engine } = await setup([{ id: 'u1', code: 'AAAA1111', status: 'in_stock', product: 'Castle', condition: 'damaged', condition_note: 'torn' }])
  const r = await engine.recordMove({ orgId: ORG, code: 'AAAA1111', direction: 'out' })
  assert.equal(r.condition, 'damaged')
  assert.equal(r.condition_note, 'torn')
})

test('returns not scanned: loading an out unit again is a new load (not same van within 3 h)', async () => {
  const { engine, server, db } = await setup()
  server.online = false
  const a = await engine.recordMove({ orgId: ORG, code: 'AAAA1111', direction: 'out', vehicleId: 'veh-1', reloadOut: true })
  assert.equal(a.result, 'ok')
  const b = await engine.recordMove({ orgId: ORG, code: 'AAAA1111', direction: 'out', vehicleId: 'veh-1', reloadOut: true })
  assert.equal(b.result, 'already', 'same van, minutes later: double scan')
  const c = await engine.recordMove({ orgId: ORG, code: 'AAAA1111', direction: 'out', vehicleId: 'veh-2', reloadOut: true })
  assert.equal(c.result, 'ok', 'other van: new load')
  assert.equal((await db.get('units', 'u1')).vehicle_id, 'veh-2')
  const d = await engine.recordMove({ orgId: ORG, code: 'AAAA1111', direction: 'out', vehicleId: 'veh-1' })
  assert.equal(d.result, 'already', 'returns scanned (default): still refused')
  const sent = (await engine.pendingEvents(ORG, 'move')).find(e => e.client_id === c.client_id)
  assert.equal(sent.reload_out, true)
})

test('reload rule: same van after 3 h is a new load', () => {
  const unit = { status: 'out', vehicle_id: 'v', out_since: '2026-11-17T08:00:00Z' }
  assert.equal(predictMove(unit, 'out', { reloadOut: true, vehicleId: 'v', at: '2026-11-17T10:59:00Z' }).result, 'already')
  assert.equal(predictMove(unit, 'out', { reloadOut: true, vehicleId: 'v', at: '2026-11-17T11:01:00Z' }).result, 'ok')
  assert.equal(predictMove(unit, 'out', { reloadOut: false, vehicleId: 'w' }).result, 'already')
})

test('stocktake when returns are not scanned: missing vs not back', () => {
  const units = [
    { id: 'a', code: 'A', product: 'P', status: 'in_stock' },
    { id: 'b', code: 'B', product: 'P', status: 'in_stock' },
    { id: 'c', code: 'C', product: 'P', status: 'out', out_since: '2026-11-01T00:00:00Z', vehicle_id: 'v2' },
    { id: 'd', code: 'D', product: 'P', status: 'out', out_since: '2026-11-10T00:00:00Z' },
    { id: 'e', code: 'E', product: 'P', status: 'lost' },
  ]
  const scans = [
    { unit_id: 'a', result: 'ok' },
    { unit_id: 'd', result: 'ok' },
    { unit_id: 'e', result: 'ok' },
  ]
  const s = computeSummary(units, scans, { scanReturns: false, closedStarts: ['2026-11-05T00:00:00Z', '2026-10-01T00:00:00Z'] })
  assert.equal(s.expected, 4)
  assert.equal(s.matched, 2)
  assert.deepEqual(s.missing.map(m => m.code), ['B'])
  assert.deepEqual(s.not_back.map(m => [m.code, m.vehicle_id, m.missed]), [['C', 'v2', 1]])
  assert.equal(s.returned, 1)
  assert.deepEqual(s.extra.map(m => m.code), ['E'])
  const r = computeSummary(units, scans) // returns scanned: out units aren't expected; a scanned one is "found"
  assert.equal(r.expected, 2)
  assert.deepEqual(r.extra.map(m => m.code), ['D', 'E'])
})

test('scan into a closed session is refused locally', async () => {
  const { engine } = await setup()
  const sid = await engine.createSession({ orgId: ORG, name: 'x' })
  await engine.markSessionClosed(sid)
  const r = await engine.recordScan({ orgId: ORG, sessionId: sid, code: 'AAAA1111' })
  assert.equal(r.result, 'session_closed')
})

test('partial batch result leaves unanswered events queued, then sends them', async () => {
  const { engine, server } = await setup()
  await engine.recordMove({ orgId: ORG, code: 'AAAA1111', direction: 'out' })
  await engine.recordMove({ orgId: ORG, code: 'AAAA1111', direction: 'in' })
  const orig = server.rpc
  let first = true
  server.rpc = async (n, a) => {
    if (n === 'sync_events' && first) {
      first = false
      const r = await orig(n, { p_events: a.p_events.slice(0, 1) })
      return r
    }
    return orig(n, a)
  }
  await engine.flush()
  const syncs = server.calls.filter(c => c.name === 'sync_events')
  assert.equal(syncs.length, 2)
  assert.equal(syncs[1].args.p_events.length, 1)
  assert.equal(syncs[1].args.p_events[0].direction, 'in', 'unanswered event sent in next round')
  assert.equal(engine.getState().pending, 0)
  assert.equal(server.units.get('AAAA1111').status, 'in_stock')
})

test('undo before sync: taken out of the queue, unit restored, nothing sent', async () => {
  const { engine, server, db } = await setup()
  server.online = false
  const r = await engine.recordMove({ orgId: ORG, code: 'AAAA1111', direction: 'out', vehicleId: 'veh-1', reference: 'Job 1' })
  assert.equal((await db.get('units', 'u1')).status, 'out')
  const u = await engine.undoMove({ orgId: ORG, move: { client_id: r.client_id, code: r.code, direction: 'out', prev: r.prev } })
  assert.equal(u.result, 'removed')
  const unit = await db.get('units', 'u1')
  assert.equal(unit.status, 'in_stock')
  assert.equal(unit.vehicle_id, null)
  assert.equal(engine.getState().pending, 0)
  server.online = true
  await engine.flush()
  assert.equal(server.calls.filter(c => c.name === 'sync_events').length, 0, 'nothing reached the server')
})

test('undo after sync: correcting move linked to the original', async () => {
  const { engine, server, db } = await setup()
  const r = await engine.recordMove({ orgId: ORG, code: 'AAAA1111', direction: 'out' })
  await engine.flush()
  assert.equal(server.units.get('AAAA1111').status, 'out')
  const u = await engine.undoMove({ orgId: ORG, move: { client_id: r.client_id, code: r.code, direction: 'out', prev: r.prev } })
  assert.equal(u.result, 'queued')
  assert.equal((await db.get('units', 'u1')).status, 'in_stock', 'predicted at once')
  await engine.flush()
  const sent = server.calls.filter(c => c.name === 'sync_events').at(-1).args.p_events[0]
  assert.equal(sent.corrects, r.client_id)
  assert.equal(sent.direction, 'in')
  assert.equal(server.units.get('AAAA1111').status, 'in_stock')
  assert.equal((await engine.cachedHistory(ORG)).find(h => h.id === u.client_id).corrects_id, r.client_id)
})

test('undo a synced check-in: back on the same van locally', async () => {
  const { engine, db } = await setup()
  await engine.recordMove({ orgId: ORG, code: 'AAAA1111', direction: 'out', vehicleId: 'veh-2', reference: 'Job 9' })
  await engine.flush()
  const r = await engine.recordMove({ orgId: ORG, code: 'AAAA1111', direction: 'in' })
  await engine.flush()
  await engine.undoMove({ orgId: ORG, move: { client_id: r.client_id, code: r.code, direction: 'in', prev: r.prev } })
  const unit = await db.get('units', 'u1')
  assert.equal(unit.status, 'out')
  assert.equal(unit.vehicle_id, 'veh-2')
  assert.equal(unit.last_ref, 'Job 9')
})

test('undo is refused when the unit moved again since', async () => {
  const { engine, server } = await setup()
  server.online = false
  const r = await engine.recordMove({ orgId: ORG, code: 'AAAA1111', direction: 'out' })
  await engine.recordMove({ orgId: ORG, code: 'AAAA1111', direction: 'in' })
  const u = await engine.undoMove({ orgId: ORG, move: { client_id: r.client_id, code: r.code, direction: 'out', prev: r.prev } })
  assert.equal(u.result, 'blocked')
  assert.equal(engine.getState().pending, 2, 'queue untouched')
})

test('undo while the original is being sent waits for the answer', async () => {
  const { engine, server, db } = await setup()
  const r = await engine.recordMove({ orgId: ORG, code: 'AAAA1111', direction: 'out' })
  const orig = server.rpc
  let release
  server.rpc = async (n, a) => {
    if (n === 'sync_events') await new Promise(res => (release = res))
    return orig(n, a)
  }
  const flushing = engine.flush()
  while (!release) await new Promise(res => setTimeout(res, 1)) // until the batch is on the wire
  const undo = engine.undoMove({ orgId: ORG, move: { client_id: r.client_id, code: r.code, direction: 'out', prev: r.prev } })
  release()
  await flushing
  const u = await undo
  assert.equal(u.result, 'queued', 'the original reached the server, so a correction is queued')
  assert.equal((await db.get('units', 'u1')).status, 'in_stock')
})

test('history search matches code, product, person and reference', async () => {
  const { engine } = await setup()
  await engine.cacheHistory(ORG, [
    { id: 'h1', code: 'BAN-PAW45-01', product: 'Paw Patrol 4x5', user_label: 'Eva', reference: 'Job 3', scanned_at: '2026-11-17T10:00:00Z' },
    { id: 'h2', code: 'CAS-001', product: 'Castle', user_label: 'Rui', reference: null, scanned_at: '2026-11-17T11:00:00Z' },
  ])
  const ids = async q => (await engine.cachedHistory(ORG, { reference: q })).map(r => r.id)
  assert.deepEqual(await ids('paw'), ['h1'])
  assert.deepEqual(await ids('ban-paw'), ['h1'])
  assert.deepEqual(await ids('rui'), ['h2'])
  assert.deepEqual(await ids('job 3'), ['h1'])
})

test('pure helpers', () => {
  assert.equal(needsAttention('move', 'ok', { result: 'already' }), true)
  assert.equal(needsAttention('move', 'unknown', { result: 'ok' }), false)
  assert.equal(needsAttention('move', 'already', { result: 'already' }), false)
  assert.equal(needsAttention('session', 'ok', { result: 'ok' }), false)
  assert.equal(needsAttention('scan', 'ok', { result: 'session_closed' }), true)
  assert.equal(isRetryable({ message: 'Failed to fetch', code: '' }, 0), true)
  assert.equal(isRetryable({ message: 'x', code: '42501' }, 403), false)
  assert.equal(isRetryable({ message: 'x', code: 'PGRST000' }, 503), true)
  const s = computeSummary([], [])
  assert.equal(s.expected, 0)
})
