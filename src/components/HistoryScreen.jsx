import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { supabase } from '../lib/supabase.js'
import { useScanner } from '../lib/useScanner.js'

const PAGE = 100
const RESULT_TEXT = {
  late: 'Not applied — a newer scan of this unit already existed',
  already: 'Server said the unit was already in that state (another device got there first)',
  unknown: 'Code not found on the server',
  retired: 'Unit is retired',
  duplicate: 'Already counted on another device',
  session_closed: 'Stocktake was closed before this scan synced',
  error: 'Rejected by the server',
}

function toIsoStart(d) {
  return d ? new Date(`${d}T00:00:00`).toISOString() : null
}
function toIsoEndExclusive(d) {
  if (!d) return null
  const x = new Date(`${d}T00:00:00`)
  x.setDate(x.getDate() + 1)
  return x.toISOString()
}

export default function HistoryScreen({ engine, orgId, settings, initialCode = '' }) {
  const sync = useSyncExternalStore(engine.subscribe, engine.getState)
  const [filters, setFilters] = useState({ code: initialCode, direction: '', reference: '', from: '', to: '' })
  const [rows, setRows] = useState(null)
  const [source, setSource] = useState('server')
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [pending, setPending] = useState([])
  const [attention, setAttention] = useState([])

  // Scanning a label on this screen filters by that unit.
  useScanner(code => setFilters(f => ({ ...f, code })), settings)

  const params = useCallback(
    (cursor = null) => ({
      p_org: orgId,
      p_code: filters.code.trim() || null,
      p_direction: filters.direction || null,
      p_reference: filters.reference.trim() || null,
      p_from: toIsoStart(filters.from),
      p_to: toIsoEndExclusive(filters.to),
      p_before_at: cursor?.scanned_at ?? null,
      p_before_id: cursor?.id ?? null,
      p_limit: PAGE,
    }),
    [orgId, filters],
  )

  const load = useCallback(async () => {
    const localFilters = {
      code: filters.code,
      direction: filters.direction,
      reference: filters.reference,
      from: toIsoStart(filters.from),
      to: toIsoEndExclusive(filters.to),
    }
    const { data, error } = await supabase.rpc('movement_history', params())
    if (error) {
      // offline (or server down): show what this device has cached
      setRows(await engine.cachedHistory(orgId, localFilters))
      setSource('cache')
      setHasMore(false)
      return
    }
    setRows(data)
    setSource('server')
    setHasMore(data.length === PAGE)
    engine.cacheHistory(orgId, data)
  }, [engine, orgId, filters, params])

  useEffect(() => {
    const t = setTimeout(load, 250) // debounce typing
    return () => clearTimeout(t)
  }, [load, sync.lastSyncAt])

  useEffect(() => {
    engine.pendingEvents(orgId, 'move').then(setPending)
    engine.listAttention(orgId).then(setAttention)
  }, [engine, orgId, sync.version, sync.pending])

  async function loadMore() {
    setLoadingMore(true)
    const { data, error } = await supabase.rpc('movement_history', params(rows[rows.length - 1]))
    setLoadingMore(false)
    if (error) return alert(error.message)
    setRows(r => [...r, ...data])
    setHasMore(data.length === PAGE)
    engine.cacheHistory(orgId, data)
  }

  function exportCsv() {
    const all = [
      ...pending.map(p => ({ ...p, applied: null, user_label: 'this device', status: 'pending sync' })),
      ...(rows ?? []).map(r => ({ ...r, status: r.applied ? 'applied' : 'not applied (late)' })),
    ]
    const head = ['scanned_at', 'code', 'product', 'direction', 'reference', 'user', 'status']
    const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`
    const lines = [head.join(',')].concat(
      all.map(r =>
        [r.scanned_at, r.code, r.product, r.direction, r.reference, r.user_label ?? r.user_email, r.status].map(esc).join(','),
      ),
    )
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `movements-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const pendingShown = pending.filter(
    p =>
      (!filters.code.trim() || p.code === filters.code.trim().toUpperCase()) &&
      (!filters.direction || p.direction === filters.direction),
  )

  return (
    <div className="stack">
      {attention.length > 0 && (
        <div className="card attention">
          <h3>⚠ Needs attention ({attention.length})</h3>
          <p className="muted small">
            These scans were saved on a device and, when they synced, the server decided differently than the screen showed
            at the time.
          </p>
          <ul className="att-list">
            {attention.map(a => (
              <li key={a.id}>
                <div>
                  <code>{a.code ?? '—'}</code> {a.product && <strong>{a.product}</strong>}{' '}
                  <span className="muted small">
                    {a.kind === 'move' ? (a.direction === 'out' ? '↑ out' : '↓ in') : a.kind} ·{' '}
                    {new Date(a.scanned_at).toLocaleString()}
                  </span>
                  <div className="small">
                    {RESULT_TEXT[a.result] ?? a.result}
                    {a.message ? `: ${a.message}` : ''}
                  </div>
                </div>
                <div className="row">
                  {a.code && (
                    <button className="link" onClick={() => setFilters(f => ({ ...f, code: a.code }))}>
                      Unit history
                    </button>
                  )}
                  <button className="ghost small-btn" onClick={() => engine.dismissAttention(a.id)}>
                    Dismiss
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="card filters">
        <label>
          Unit code
          <input
            placeholder="Scan or type"
            value={filters.code}
            onChange={e => setFilters({ ...filters, code: e.target.value.toUpperCase() })}
          />
        </label>
        <label>
          Direction
          <select value={filters.direction} onChange={e => setFilters({ ...filters, direction: e.target.value })}>
            <option value="">Both</option>
            <option value="out">Out</option>
            <option value="in">In</option>
          </select>
        </label>
        <label>
          Reference
          <input value={filters.reference} onChange={e => setFilters({ ...filters, reference: e.target.value })} />
        </label>
        <label>
          From
          <input type="date" value={filters.from} onChange={e => setFilters({ ...filters, from: e.target.value })} />
        </label>
        <label>
          To
          <input type="date" value={filters.to} onChange={e => setFilters({ ...filters, to: e.target.value })} />
        </label>
        <div className="row filter-actions">
          <button className="ghost" onClick={() => setFilters({ code: '', direction: '', reference: '', from: '', to: '' })}>
            Clear
          </button>
          <button className="secondary" onClick={exportCsv} disabled={!rows?.length && !pending.length}>
            Export CSV
          </button>
        </div>
      </div>

      {source === 'cache' && (
        <div className="notice offline">
          Offline — showing the {rows?.length ?? 0} movements stored on this device. Connect to see the full history.
        </div>
      )}

      <table className="table">
        <thead>
          <tr>
            <th>When</th>
            <th>Unit</th>
            <th>Movement</th>
            <th>Reference</th>
            <th>By</th>
          </tr>
        </thead>
        <tbody>
          {pendingShown.map(p => (
            <tr key={p.client_id} className="pending-row">
              <td>{new Date(p.scanned_at).toLocaleString()}</td>
              <td>
                <code>{p.code}</code> <span className="muted small">{p.product ?? ''}</span>
              </td>
              <td>
                <Dir d={p.direction} /> <span className="pill pending">⏳ waiting to sync</span>
              </td>
              <td>{p.reference ?? ''}</td>
              <td className="muted small">this device</td>
            </tr>
          ))}
          {rows === null ? (
            <tr>
              <td colSpan={5} className="muted">
                Loading…
              </td>
            </tr>
          ) : rows.length === 0 && pendingShown.length === 0 ? (
            <tr>
              <td colSpan={5} className="muted">
                No movements match.
              </td>
            </tr>
          ) : (
            rows.map(r => (
              <tr key={r.id} className={r.applied ? '' : 'late-row'}>
                <td>{new Date(r.scanned_at).toLocaleString()}</td>
                <td>
                  <button className="link mono" onClick={() => setFilters(f => ({ ...f, code: r.code }))}>
                    {r.code}
                  </button>{' '}
                  <span className="muted small">{r.product}</span>
                </td>
                <td>
                  <Dir d={r.direction} />
                  {!r.applied && (
                    <span className="pill lost" title={RESULT_TEXT.late}>
                      not applied
                    </span>
                  )}
                </td>
                <td>{r.reference ?? ''}</td>
                <td className="muted small">{r.user_label ?? r.user_email ?? ''}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
      {hasMore && (
        <button className="ghost" onClick={loadMore} disabled={loadingMore}>
          {loadingMore ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  )
}

function Dir({ d }) {
  return <span className={`dir ${d}`}>{d === 'out' ? '↑ Out' : '↓ In'}</span>
}
