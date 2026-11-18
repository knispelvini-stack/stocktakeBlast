import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { supabase } from '../lib/supabase.js'
import Icon from './ui/Icon.jsx'
import { PageHeader, Section, Stat, EmptyState, Badge, timeAgo } from './ui/ui.jsx'

// Everything here comes from the device's local cache, so the overview also
// works offline. Numbers refresh whenever the sync engine changes data.
export default function OverviewScreen({ engine, orgId, go, onShowHistory, overdueDays = 3, scanReturns = true }) {
  const sync = useSyncExternalStore(engine.subscribe, engine.getState)
  const [units, setUnits] = useState(null)
  const [vehicles, setVehicles] = useState([])
  const [recent, setRecent] = useState([])
  const [pending, setPending] = useState([])
  const [attention, setAttention] = useState(0)
  const [sessions, setSessions] = useState([])

  useEffect(() => {
    let alive = true
    Promise.all([
      engine.listUnits(orgId),
      engine.listVehicles(orgId),
      engine.cachedHistory(orgId),
      engine.pendingEvents(orgId, 'move'),
      engine.listAttention(orgId),
      engine.listSessions(orgId),
    ]).then(([u, v, h, p, a, ss]) => {
      if (!alive) return
      setUnits(u)
      setVehicles(v)
      setRecent(h.slice(0, 8))
      setPending(p)
      setAttention(a.length)
      setSessions(ss)
    })
    // Fresh activity from the server when online (the cache above is the offline fallback).
    supabase.rpc('activity_feed', { p_org: orgId, p_limit: 8 }).then(({ data, error }) => {
      if (!alive || error) return
      setRecent(data)
      engine.cacheHistory(orgId, data)
    })
    return () => {
      alive = false
    }
  }, [engine, orgId, sync.version, sync.lastSyncAt])

  const stats = useMemo(() => {
    const s = { total: 0, in_stock: 0, out: 0, lost: 0, damaged: 0, available: 0 }
    for (const u of units ?? []) {
      if (u.status === 'retired') continue
      s.total++
      s[u.status] = (s[u.status] ?? 0) + 1
      if (u.condition === 'damaged') s.damaged++
      else if (u.status === 'in_stock') s.available++
    }
    return s
  }, [units])

  const outGroups = useMemo(() => {
    const groups = new Map()
    for (const u of units ?? []) {
      if (u.status !== 'out') continue
      // A registered vehicle wins over the free-text reference.
      const key = u.vehicle_id ? `veh:${u.vehicle_id}` : u.last_ref?.trim() || ''
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(u)
    }
    const vById = Object.fromEntries(vehicles.map(v => [v.id, v]))
    return [...groups.entries()]
      .map(([key, list]) => ({
        key,
        vehicle: key.startsWith('veh:') ? vById[key.slice(4)] ?? { name: 'Vehicle' } : null,
        ref: key.startsWith('veh:') ? '' : key,
        refs: [...new Set(list.map(u => u.last_ref).filter(Boolean))],
        list: list.sort((a, b) => (a.out_since || '').localeCompare(b.out_since || '')),
        since: list.reduce((m, u) => (u.out_since && (!m || u.out_since < m) ? u.out_since : m), null),
      }))
      .sort((a, b) => b.list.length - a.list.length)
  }, [units, vehicles])

  // Returns scanned: out longer than the company's limit (Settings → Company).
  // Returns not scanned: loaded before the last finished stocktake and not
  // scanned in it (it would be back in stock otherwise) — "not seen".
  const lastCount = sessions.find(x => x.status === 'closed')
  const overdue = useMemo(() => {
    if (!scanReturns) {
      if (!lastCount) return []
      return (units ?? [])
        .filter(u => u.status === 'out' && u.out_since && u.out_since < lastCount.created_at)
        .sort((a, b) => a.out_since.localeCompare(b.out_since))
    }
    const limit = Date.now() - overdueDays * 86400_000
    return (units ?? [])
      .filter(u => u.status === 'out' && u.out_since && Date.parse(u.out_since) < limit)
      .sort((a, b) => a.out_since.localeCompare(b.out_since))
  }, [units, overdueDays, scanReturns, lastCount])
  const overdueIds = new Set(overdue.map(u => u.id))
  const damaged = (units ?? []).filter(u => u.condition === 'damaged' && u.status !== 'retired')
  const vName = id => vehicles.find(v => v.id === id)?.name

  const today = new Date().toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })

  if (units === null) return <PageHeader title="Overview" description={today} />

  if (stats.total === 0) {
    return (
      <>
        <PageHeader title="Overview" description={today} />
        <Section>
          <EmptyState
            icon="box"
            title="Set up your inventory"
            action={
              <button className="primary" onClick={() => go('inventory')}>
                <Icon name="plus" /> Add your first product
              </button>
            }
          >
            Add a product, generate one label per physical item, print the labels and stick them on. Then scan
            items out and in from <strong>Check out / in</strong>.
          </EmptyState>
        </Section>
      </>
    )
  }

  const pct = n => (stats.total ? Math.round((n / stats.total) * 100) : 0)

  return (
    <>
      <PageHeader
        title="Overview"
        description={today}
        actions={
          <>
            <button className="secondary" onClick={() => go('count')}>
              <Icon name="clipboard" /> Start stocktake
            </button>
            <button className="primary" onClick={() => go('move')}>
              <Icon name="scan" /> Check out / in
            </button>
          </>
        }
      />

      {attention > 0 && (
        <div className="notice warn">
          <Icon name="alert" />
          <div className="grow">
            <strong>
              {attention} scan{attention === 1 ? '' : 's'} need{attention === 1 ? 's' : ''} attention.
            </strong>{' '}
            The server decided differently than the device showed when they synced.
          </div>
          <button className="link" onClick={() => go('activity')}>
            Review
          </button>
        </div>
      )}

      <div className="stats">
        <Stat icon="box" label="Total units" value={stats.total} hint="excluding retired" />
        <Stat
          icon="check"
          label="Available"
          value={stats.available}
          hint={stats.damaged ? `${stats.in_stock} in stock · ${stats.damaged} damaged` : `${pct(stats.available)}% of units`}
          tone="ok"
        />
        <Stat icon="truck" label="Out" value={stats.out} hint={`${outGroups.length} location${outGroups.length === 1 ? '' : 's'}`} tone={stats.out ? 'warn' : ''} />
        <Stat icon="alert" label="Lost" value={stats.lost} hint="not returned or not found" tone={stats.lost ? 'error' : ''} />
      </div>

      {overdue.length > 0 && (
        <Section
          flush
          title={
            <span className="row" style={{ gap: 8 }}>
              <Icon name="clock" /> {scanReturns ? 'Overdue' : 'Not seen in the last stocktake'} ({overdue.length})
            </span>
          }
          description={
            scanReturns
              ? `Out for more than ${overdueDays} day${overdueDays === 1 ? '' : 's'} — chase these up`
              : `Loaded before “${lastCount?.name}” and not scanned in it — still at a job, or lost`
          }
        >
          <ul className="list" data-testid="overdue">
            {overdue.slice(0, 20).map(u => (
              <li key={u.id} className="clickable" onClick={() => onShowHistory(u.code)}>
                <div className="li-main">
                  <span className="li-title mono">{u.code}</span>
                  <span className="li-sub">
                    {u.product}
                    {u.vehicle_id && vName(u.vehicle_id) ? ` · ${vName(u.vehicle_id)}` : ''}
                    {u.last_ref ? ` · ${u.last_ref}` : ''}
                  </span>
                </div>
                <div className="li-end">
                  <Badge tone="error">{scanReturns ? 'out' : 'loaded'} {timeAgo(u.out_since).replace(' ago', '')}</Badge>
                </div>
              </li>
            ))}
            {overdue.length > 20 && <li className="muted small">+{overdue.length - 20} more</li>}
          </ul>
        </Section>
      )}

      {damaged.length > 0 && (
        <Section
          flush
          title={`Damaged (${damaged.length})`}
          description="Not available until marked repaired (Inventory → product → Manage)"
        >
          <ul className="list" data-testid="damaged-list">
            {damaged.slice(0, 10).map(u => (
              <li key={u.id} className="clickable" onClick={() => onShowHistory(u.code)}>
                <div className="li-main">
                  <span className="li-title mono">{u.code}</span>
                  <span className="li-sub">
                    {u.product}
                    {u.condition_note ? ` · ${u.condition_note}` : ''}
                  </span>
                </div>
                <div className="li-end">{u.status === 'out' ? <Badge tone="warn">out</Badge> : null}</div>
              </li>
            ))}
            {damaged.length > 10 && <li className="muted small">+{damaged.length - 10} more</li>}
          </ul>
        </Section>
      )}

      <div className="overview-grid">
        <Section
          flush
          title={scanReturns ? 'Out right now' : 'Last loaded'}
          description={
            scanReturns
              ? 'Grouped by the reference used when checking out'
              : 'Loaded and not scanned in a stocktake since (returns aren’t scanned)'
          }
        >
          {outGroups.length === 0 ? (
            <EmptyState icon="check" title="Everything is in">
              No units are checked out.
            </EmptyState>
          ) : (
            outGroups.map(g => (
              <div className="ref-group" key={g.key || '—'} data-testid="out-group">
                <div className="ref-head">
                  <div className="ref-name">
                    <Icon name="truck" />
                    {g.vehicle ? (
                      <>
                        {g.vehicle.name}
                        {g.vehicle.plate && <span className="muted small mono">{g.vehicle.plate}</span>}
                      </>
                    ) : (
                      g.ref || <span className="muted">No vehicle or reference</span>
                    )}
                    <Badge tone="warn">{g.list.length}</Badge>
                  </div>
                  <span className="muted small">{g.since ? `since ${timeAgo(g.since)}` : ''}</span>
                </div>
                <div className="codes ref-units">
                  {g.list.slice(0, 12).map(u => (
                    <code
                      key={u.id}
                      title={overdueIds.has(u.id) ? `${u.product} — overdue` : u.product}
                      className={`clickable${overdueIds.has(u.id) ? ' overdue' : ''}`}
                      onClick={() => onShowHistory(u.code)}
                    >
                      {u.code}
                    </code>
                  ))}
                  {g.list.length > 12 && <span className="muted small">+{g.list.length - 12} more</span>}
                </div>
              </div>
            ))
          )}
        </Section>

        <Section
          flush
          title="Recent activity"
          actions={
            <button className="ghost btn-sm" onClick={() => go('activity')}>
              View all <Icon name="chevronRight" size={16} />
            </button>
          }
        >
          {recent.length === 0 && pending.length === 0 ? (
            <EmptyState icon="activity" title="No movements yet" />
          ) : (
            <ul className="list">
              {pending.slice(0, 3).map(p => (
                <li key={p.client_id}>
                  <MoveIcon d={p.direction} />
                  <div className="li-main">
                    <span className="li-title mono">{p.code}</span>
                    <span className="li-sub">{p.product ?? 'Unknown'}</span>
                  </div>
                  <div className="li-end">
                    <Badge tone="warn">Waiting to sync</Badge>
                  </div>
                </li>
              ))}
              {recent.slice(0, 8 - Math.min(3, pending.length)).map(r => (
                <li key={r.id} className="clickable" onClick={() => onShowHistory(r.code)}>
                  <MoveIcon d={r.direction} />
                  <div className="li-main">
                    <span className="li-title mono">{r.code}</span>
                    <span className="li-sub">
                      {r.product}
                      {r.reference ? ` · ${r.reference}` : ''}
                    </span>
                  </div>
                  <div className="li-end">{timeAgo(r.scanned_at)}</div>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </>
  )
}

function MoveIcon({ d }) {
  return (
    <span className={`dir ${d}`} title={d === 'out' ? 'Checked out' : 'Checked in'}>
      <Icon name={d === 'out' ? 'arrowUp' : 'arrowDown'} size={16} />
    </span>
  )
}
