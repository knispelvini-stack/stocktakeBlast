// Pure, local predictions of what the server will decide. They give the
// operator instant feedback (online or offline); the server's answer during
// sync is authoritative and overrides them.

export function predictMove(unit, direction) {
  if (!unit) return { result: 'unknown' }
  if (unit.status === 'retired') return { result: 'retired', status: unit.status }
  const next = direction === 'out' ? 'out' : 'in_stock'
  if (unit.status === next) return { result: 'already', status: unit.status }
  return { result: 'ok', status: next, previous: unit.status }
}

export function predictScan(unit, sessionScans) {
  if (!unit) return { result: 'unknown' }
  const dup = sessionScans.some(s => s.unit_id === unit.id && s.result === 'ok' && !s.voided)
  return { result: dup ? 'duplicate' : 'ok', unit_status: unit.status }
}

// Same semantics as the server's count_summary():
//   expected = units in_stock; missing = expected not scanned;
//   extra = scanned units the system has as out/lost/retired; unknown = codes with no unit.
export function computeSummary(units, allScans) {
  const scans = allScans.filter(s => !s.voided)
  const okIds = new Set(scans.filter(s => s.result === 'ok' && s.unit_id).map(s => s.unit_id))
  const expected = units.filter(u => u.status === 'in_stock')
  const byId = new Map(units.map(u => [u.id, u]))
  const sortKey = (a, b) => (a.product || '').localeCompare(b.product || '') || a.code.localeCompare(b.code)

  const missing = expected
    .filter(u => !okIds.has(u.id))
    .map(u => ({ code: u.code, product: u.product }))
    .sort(sortKey)
  const extra = [...okIds]
    .map(id => byId.get(id))
    .filter(u => u && u.status !== 'in_stock')
    .map(u => ({ code: u.code, product: u.product, status: u.status }))
    .sort(sortKey)
  const unknown = [...new Set(scans.filter(s => s.result === 'unknown').map(s => s.code))]

  return {
    expected: expected.length,
    scanned: okIds.size,
    matched: expected.length - missing.length,
    missing,
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
