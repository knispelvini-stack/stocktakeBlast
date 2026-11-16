import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { supabase } from '../lib/supabase.js'
import Icon from './ui/Icon.jsx'
import { PageHeader, Section, Stat, EmptyState, Badge, timeAgo } from './ui/ui.jsx'

// Everything here comes from the device's local cache, so the overview also
// works offline. Numbers refresh whenever the sync engine changes data.
export default function OverviewScreen({ engine, orgId, go, onShowHistory }) {
  const sync = useSyncExternalStore(engine.subscribe, engine.getState)
  const [units, setUnits] = useState(null)
  const [recent, setRecent] = useState([])
  const [pending, setPending] = useState([])
  const [attention, setAttention] = useState(0)

  useEffect(() => {
    let alive = true
    Promise.all([
      engine.listUnits(orgId),
      engine.cachedHistory(orgId),
      engine.pendingEvents(orgId, 'move'),
      engine.listAttention(orgId),
    ]).then(([u, h, p, a]) => {
      if (!alive) return
      setUnits(u)
      setRecent(h.slice(0, 8))
      setPending(p)
      setAttention(a.length)
    })
    // Fresh activity from the server when online (the cache above is the offline fallback).
    supabase.rpc('movement_history', { p_org: orgId, p_limit: 8 }).then(({ data, error }) => {
      if (!alive || error) return
      setRecent(data)
      engine.cacheHistory(orgId, data)
    })
    return () => {
      alive = false
    }
  }, [engine, orgId, sync.version, sync.lastSyncAt])

  const stats = useMemo(() => {
    const s = { total: 0, in_stock: 0, out: 0, lost: 0 }
    for (const u of units ?? []) {
      if (u.status === 'retired') continue
      s.total++
      s[u.status] = (s[u.status] ?? 0) + 1
    }
    return s
  }, [units])

  const outGroups = useMemo(() => {
    const groups = new Map()
    for (const u of units ?? []) {
      if (u.status !== 'out') continue
      const key = u.last_ref?.trim() || ''
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(u)
    }
    return [...groups.entries()]
      .map(([ref, list]) => ({
        ref,
        list: list.sort((a, b) => (a.out_since || '').localeCompare(b.out_since || '')),
        since: list.reduce((m, u) => (u.out_since && (!m || u.out_since < m) ? u.out_since : m), null),
      }))
      .sort((a, b) => b.list.length - a.list.length)
  }, [units])

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
        <Stat icon="check" label="In stock" value={stats.in_stock} hint={`${pct(stats.in_stock)}% available`} tone="ok" />
        <Stat icon="truck" label="Out" value={stats.out} hint={`${outGroups.length} location${outGroups.length === 1 ? '' : 's'}`} tone={stats.out ? 'warn' : ''} />
        <Stat icon="alert" label="Lost" value={stats.lost} hint="missing in a stocktake" tone={stats.lost ? 'error' : ''} />
      </div>

      <div className="overview-grid">
        <Section
          flush
          title="Out right now"
          description="Grouped by the reference used when checking out"
        >
          {outGroups.length === 0 ? (
            <EmptyState icon="check" title="Everything is in">
              No units are checked out.
            </EmptyState>
          ) : (
            outGroups.map(g => (
              <div className="ref-group" key={g.ref || '—'}>
                <div className="ref-head">
                  <div className="ref-name">
                    <Icon name="truck" />
                    {g.ref || <span className="muted">No reference</span>}
                    <Badge tone="warn">{g.list.length}</Badge>
                  </div>
                  <span className="muted small">{g.since ? `since ${timeAgo(g.since)}` : ''}</span>
                </div>
                <div className="codes ref-units">
                  {g.list.slice(0, 12).map(u => (
                    <code key={u.id} title={u.product} className="clickable" onClick={() => onShowHistory(u.code)}>
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
