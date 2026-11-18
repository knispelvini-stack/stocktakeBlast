// Pure, local predictions of what the server will decide. They give the
// operator instant feedback (online or offline); the server's answer during
// sync is authoritative and overrides them.

export const RELOAD_GAP_MS = 3 * 3600_000

// reloadOut: the company doesn't scan returns, so loading a unit that is still
// "out" is a new load (it came back unscanned) — unless it's the same vehicle
// within 3 hours (a double scan of the same load). Same rule as _sync_move.
export function predictMove(unit, direction, { reloadOut = false, vehicleId = null, at = null } = {}) {
  if (!unit) return { result: 'unknown' }
  if (unit.status === 'retired') return { result: 'retired', status: unit.status }
  const next = direction === 'out' ? 'out' : 'in_stock'
  if (unit.status === next) {
    const reload =
      next === 'out' &&
      reloadOut &&
      !(
        (unit.vehicle_id ?? null) === (vehicleId ?? null) &&
        unit.out_since &&
        Date.parse(at ?? new Date().toISOString()) < Date.parse(unit.out_since) + RELOAD_GAP_MS
      )
    if (!reload) return { result: 'already', status: unit.status }
  }
  return { result: 'ok', status: next, previous: unit.status }
}

export function predictScan(unit, sessionScans) {
  if (!unit) return { result: 'unknown' }
  const dup = sessionScans.some(s => s.unit_id === unit.id && s.result === 'ok' && !s.voided)
  return { result: dup ? 'duplicate' : 'ok', unit_status: unit.status }
}

// Same semantics as the server's count_summary():
//   expected = units in_stock (+ out ones when returns aren't scanned);
//   missing  = in-stock units not scanned;
//   not_back = out units not scanned (where last loaded, how many earlier stocktakes missed them);
//   extra    = scanned units the system has as lost/retired (or out, when returns are scanned);
//   unknown  = codes with no unit. Voided scans don't count.
// closedStarts: start times of the company's other closed stocktakes.
export function computeSummary(units, allScans, { scanReturns = true, closedStarts = [] } = {}) {
  const scans = allScans.filter(s => !s.voided)
  const okIds = new Set(scans.filter(s => s.result === 'ok' && s.unit_id).map(s => s.unit_id))
  const expected = units.filter(u => u.status === 'in_stock' || (!scanReturns && u.status === 'out'))
  const byId = new Map(units.map(u => [u.id, u]))
  const sortKey = (a, b) => (a.product || '').localeCompare(b.product || '') || a.code.localeCompare(b.code)

  const missing = expected
    .filter(u => u.status === 'in_stock' && !okIds.has(u.id))
    .map(u => ({ code: u.code, product: u.product }))
    .sort(sortKey)
  const notBack = units
    .filter(u => u.status === 'out' && !okIds.has(u.id))
    .map(u => ({
      code: u.code,
      product: u.product,
      out_since: u.out_since ?? null,
      vehicle_id: u.vehicle_id ?? null,
      reference: u.last_ref ?? null,
      missed: u.out_since ? closedStarts.filter(t => t > u.out_since).length : 0,
    }))
    .sort((a, b) => (a.out_since || '').localeCompare(b.out_since || '') || a.code.localeCompare(b.code))
  const scannedUnits = [...okIds].map(id => byId.get(id)).filter(Boolean)
  const returned = scanReturns ? 0 : scannedUnits.filter(u => u.status === 'out').length
  const extra = scannedUnits
    .filter(u => u.status === 'lost' || u.status === 'retired' || (scanReturns && u.status === 'out'))
    .map(u => ({ code: u.code, product: u.product, status: u.status }))
    .sort(sortKey)
  const unknown = [...new Set(scans.filter(s => s.result === 'unknown').map(s => s.code))]

  return {
    expected: expected.length,
    scanned: okIds.size,
    matched: expected.filter(u => okIds.has(u.id)).length,
    missing,
    not_back: notBack,
    returned,
    extra,
    unknown,
  }
}

// Server results a human should look at after sync: failures, conflicts, and
// cases where the operator was told "ok" but the server disagreed. (A code the
// device didn't know that turns out to be valid is good news, not a problem.)
export function needsAttention(kind, predicted, server) {
  if (['error', 'late', 'session_closed'].includes(server.result)) return true
  if (kind === 'session') return false
  return predicted === 'ok' && server.result !== 'ok'
}

// Network failures (and 5xx) are retried; anything else is a real error.
export function isRetryable(error, status) {
  if (!error) return false
  if (!error.code) return true // fetch failed: offline, DNS, CORS, timeout
  if (status >= 500 || status === 0) return true
  return false
}

export function isAuthError(error, status) {
  return status === 401 || error?.code === 'PGRST301' || error?.code === 'PGRST303'
}
