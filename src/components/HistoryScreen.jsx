import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { supabase } from '../lib/supabase.js'
import { useScanner } from '../lib/useScanner.js'
import Icon from './ui/Icon.jsx'
import { PageHeader, Section, EmptyState, Badge, useUI, formatDateTime } from './ui/ui.jsx'

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
  const ui = useUI()
  const sync = useSyncExternalStore(engine.subscribe, engine.getState)
  const [filters, setFilters] = useState({ code: initialCode, direction: '', reference: '', from: '', to: '', vehicle: '' })
  const [rows, setRows] = useState(null)
  const [source, setSource] = useState('server')
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [pending, setPending] = useState([])
  const [attention, setAttention] = useState([])
  const [vehicles, setVehicles] = useState([])
  useEffect(() => {
    engine.listVehicles(orgId).then(setVehicles)
  }, [engine, orgId, sync.version])
  const vName = r => r.vehicle ?? vehicles.find(v => v.id === r.vehicle_id)?.name ?? null

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
      p_vehicle: filters.vehicle || null,
    }),
    [orgId, filters],
  )

  const load = useCallback(async () => {
    const localFilters = {
      code: filters.code,
      direction: filters.direction,
      reference: filters.reference,
      vehicle: filters.vehicle,
      from: toIsoStart(filters.from),
      to: toIsoEndExclusive(filters.to),
    }
    const { data, error } = await supabase.rpc('activity_feed', params())
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
    const { data, error } = await supabase.rpc('activity_feed', params(rows[rows.length - 1]))
    setLoadingMore(false)
    if (error) return ui.toast(error.message, 'error')
    setRows(r => [...r, ...data])
    setHasMore(data.length === PAGE)
    engine.cacheHistory(orgId, data)
  }

  function exportCsv() {
    const all = [
      ...pending.map(p => ({ ...p, applied: null, user_label: 'this device', status: 'pending sync' })),
      ...(rows ?? []).map(r => ({
        ...r,
        status: !r.applied ? 'not applied (late)' : r.corrects_id ? 'undo of an earlier scan' : r.undone ? 'applied, later undone' : 'applied',
      })),
    ]
    const head = ['scanned_at', 'code', 'product', 'direction', 'vehicle', 'reference', 'user', 'status']
    const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`
    const lines = [head.join(',')].concat(
      all.map(r =>
        [r.scanned_at, r.code, r.product, r.direction, vName(r), r.reference, r.user_label ?? r.user_email, r.status].map(esc).join(','),
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
      (!filters.direction || p.direction === filters.direction) &&
      (!filters.vehicle || p.vehicle_id === filters.vehicle) &&
      (!filters.reference.trim() ||
        [p.code, p.product, p.reference, vName(p)].some(x => (x || '').toLowerCase().includes(filters.reference.trim().toLowerCase()))),
  )

  const hasFilters = Object.values(filters).some(v => String(v).trim())

  return (
    <>
      <PageHeader
        title="Activity"
        description="Every check-out and check-in, with who did it and where it went. Scan a label here to filter by it."
        actions={
          <button className="secondary" onClick={exportCsv} disabled={!rows?.length && !pending.length}>
            <Icon name="download" /> Export CSV
          </button>
        }
      />

      {attention.length > 0 && (
        <Section
          flush
          title={
            <span className="row" style={{ gap: 8 }}>
              <Icon name="alert" /> Needs attention ({attention.length})
            </span>
          }
          description="Saved on a device while offline; when they synced, the server decided differently than the screen showed."
        >
          <ul className="att-list">
            {attention.map(a => (
              <li key={a.id}>
                <div>
                  <code>{a.code ?? '—'}</code> {a.product && <strong>{a.product}</strong>}{' '}
                  <span className="muted small">
                    {a.kind === 'move' ? (a.direction === 'out' ? 'check-out' : 'check-in') : a.kind} ·{' '}
                    {formatDateTime(a.scanned_at)}
                  </span>
                  <div className="small muted">
                    {RESULT_TEXT[a.result] ?? a.result}
                    {a.message ? `: ${a.message}` : ''}
                  </div>
                </div>
                <div className="row">
                  {a.code && (
                    <button className="ghost small-btn" onClick={() => setFilters(f => ({ ...f, code: a.code }))}>
                      Unit history
                    </button>
                  )}
                  <button className="secondary small-btn" onClick={() => engine.dismissAttention(a.id)}>
                    Dismiss
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {source === 'cache' && (
        <div className="notice offline">
          <Icon name="wifiOff" />
          <div>Offline — showing the {rows?.length ?? 0} movements stored on this device. Connect to see the full history.</div>
        </div>
      )}

      <section className="panel flush">
        <div className="filters">
          <label>
            Unit code
            <div className="input-icon">
              <Icon name="barcode" size={16} />
              <input
                placeholder="Scan or type"
                value={filters.code}
                onChange={e => setFilters({ ...filters, code: e.target.value.toUpperCase() })}
              />
            </div>
          </label>
          <label>
            Direction
            <select value={filters.direction} onChange={e => setFilters({ ...filters, direction: e.target.value })}>
              <option value="">Out and in</option>
              <option value="out">Check-outs</option>
              <option value="in">Check-ins</option>
            </select>
          </label>
          <label>
            Vehicle
            <select value={filters.vehicle} onChange={e => setFilters({ ...filters, vehicle: e.target.value })} data-testid="history-vehicle">
              <option value="">All</option>
              {vehicles.map(v => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
          </label>
          <label className="filter-search">
            Search
            <div className="input-icon">
              <Icon name="search" size={16} />
              <input
                placeholder="Product, code, person, van, job…"
                value={filters.reference}
                onChange={e => setFilters({ ...filters, reference: e.target.value })}
                data-testid="history-search"
              />
            </div>
          </label>
          <label>
            From
            <input type="date" value={filters.from} onChange={e => setFilters({ ...filters, from: e.target.value })} />
          </label>
          <label>
            To
            <input type="date" value={filters.to} onChange={e => setFilters({ ...filters, to: e.target.value })} />
          </label>
        </div>
        {hasFilters && (
          <div className="row" style={{ padding: '10px 20px', borderBottom: '1px solid var(--border)', justifyContent: 'space-between' }}>
            <span className="muted small">Filtered results</span>
            <button className="ghost btn-sm" onClick={() => setFilters({ code: '', direction: '', reference: '', from: '', to: '', vehicle: '' })}>
              <Icon name="x" size={14} /> Clear filters
            </button>
          </div>
        )}

        {rows !== null && rows.length === 0 && pendingShown.length === 0 ? (
          <EmptyState icon="activity" title={hasFilters ? 'No movements match' : 'No movements yet'}>
            {hasFilters ? 'Try clearing a filter.' : 'Check-outs and check-ins appear here as soon as they’re scanned.'}
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table history-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Unit</th>
                  <th>Movement</th>
                  <th>Vehicle / reference</th>
                  <th>By</th>
                </tr>
              </thead>
              <tbody>
                {pendingShown.map(p => (
                  <tr key={p.client_id} className="pending-row">
                    <td className="muted">{formatDateTime(p.scanned_at)}</td>
                    <td>
                      <code>{p.code}</code> <span className="muted small">{p.product ?? ''}</span>
                    </td>
                    <td>
                      <Dir d={p.direction} /> <Badge tone="warn">waiting to sync</Badge>
                    </td>
                    <td><Where name={vName(p)} reference={p.reference} /></td>
                    <td className="muted small">this device</td>
                  </tr>
                ))}
                {rows === null ? (
                  <tr>
                    <td colSpan={5} className="muted">
                      Loading…
                    </td>
                  </tr>
                ) : (
                  rows.map(r => (
                    <tr key={r.id} className={!r.applied ? 'late-row' : r.undone ? 'row-undone' : ''}>
                      <td className="muted">{formatDateTime(r.scanned_at)}</td>
                      <td>
                        <button className="link mono" onClick={() => setFilters(f => ({ ...f, code: r.code }))}>
                          {r.code}
                        </button>{' '}
                        <span className="muted small">{r.product}</span>
                      </td>
                      <td>
                        <Dir d={r.direction} />
                        {!r.applied && (
                          <span title={RESULT_TEXT.late}>
                            <Badge tone="error">not applied</Badge>
                          </span>
                        )}
                        {r.applied && r.corrects_id && <Badge tone="neutral">undo</Badge>}
                        {r.applied && r.undone && (
                          <span title="This scan was undone by the device that made it">
                            <Badge tone="warn">undone</Badge>
                          </span>
                        )}
                      </td>
                      <td><Where name={vName(r)} reference={r.reference} /></td>
                      <td className="muted small">{r.user_label ?? r.user_email ?? ''}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {hasMore && (
        <button className="secondary" onClick={loadMore} disabled={loadingMore} style={{ alignSelf: 'center' }}>
          {loadingMore ? 'Loading…' : 'Load more'}
        </button>
      )}
    </>
  )
}

function Dir({ d }) {
  return (
    <span className={`dir ${d}`}>
      <Icon name={d === 'out' ? 'arrowUp' : 'arrowDown'} size={15} />
      {d === 'out' ? 'Out' : 'In'}
    </span>
  )
}

function Where({ name, reference }) {
  if (!name && !reference) return null
  return (
    <span className="where">
      {name && (
        <span className="where-vehicle">
          <Icon name="truck" size={14} /> {name}
        </span>
      )}
      {reference && <span className="muted">{reference}</span>}
    </span>
  )
}
