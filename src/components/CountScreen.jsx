import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { supabase } from '../lib/supabase.js'
import { useScanner } from '../lib/useScanner.js'
import { beep } from '../lib/beep.js'
import { ScanInput, ScanFlash, ScanFeed, makeEntry } from './ScanParts.jsx'
import Icon from './ui/Icon.jsx'
import { PageHeader, Section, Stat, EmptyState, Badge, StatusBadge, Modal, useUI, formatDateTime } from './ui/ui.jsx'

export default function CountScreen({ engine, orgId, settings }) {
  const sync = useSyncExternalStore(engine.subscribe, engine.getState)
  const [sessions, setSessions] = useState(null)
  const [activeId, setActiveId] = useState(null)
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    engine.listSessions(orgId).then(setSessions)
  }, [engine, orgId, sync.version])

  const defaultName = `Stocktake ${new Date().toLocaleDateString()}`

  async function create(e) {
    e.preventDefault()
    const id = await engine.createSession({ orgId, name: name.trim() || defaultName })
    setName('')
    setCreating(false)
    setActiveId(id)
  }

  const active = sessions?.find(s => s.id === activeId)
  if (active) {
    return <CountSession engine={engine} orgId={orgId} session={active} settings={settings} onBack={() => setActiveId(null)} />
  }

  const newButton = (
    <button className="primary" onClick={() => setCreating(true)}>
      <Icon name="plus" /> New stocktake
    </button>
  )

  return (
    <>
      <PageHeader
        title="Stocktake"
        description="Count every unit on the shelves and compare with what the system expects."
        actions={newButton}
      />
      {!sync.online && (
        <div className="notice offline">
          <Icon name="wifiOff" />
          <div>Offline: you can start and count a stocktake now; it syncs when the connection is back.</div>
        </div>
      )}

      <Section flush title="All stocktakes">
        {sessions === null ? (
          <p className="muted" style={{ padding: 20 }}>
            Loading…
          </p>
        ) : sessions.length === 0 ? (
          <EmptyState icon="clipboard" title="No stocktakes yet" action={newButton}>
            Start one, then walk the warehouse scanning every label you can find. Several devices can count the same
            stocktake at once.
          </EmptyState>
        ) : (
          <ul className="list">
            {sessions.map(s => (
              <li key={s.id} onClick={() => setActiveId(s.id)} className="clickable">
                <div className="li-main">
                  <span className="li-title">{s.name}</span>
                  <span className="li-sub">
                    Started {formatDateTime(s.created_at)}
                    {s.closed_at ? ` · finished ${formatDateTime(s.closed_at)}` : ''}
                  </span>
                </div>
                <div className="li-end">
                  {s.pending && <Badge tone="warn">Not synced</Badge>}
                  <StatusBadge status={s.status} />
                  <Icon name="chevronRight" size={16} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {creating && (
        <form onSubmit={create}>
          <Modal
            title="New stocktake"
            description="Give it a name so you can find it later."
            onClose={() => setCreating(false)}
            footer={
              <>
                <button type="button" className="secondary" onClick={() => setCreating(false)}>
                  Cancel
                </button>
                <button className="primary">Start counting</button>
              </>
            }
          >
            <label>
              Name
              <input placeholder={defaultName} value={name} onChange={e => setName(e.target.value)} />
            </label>
          </Modal>
        </form>
      )}
    </>
  )
}

function CountSession({ engine, orgId, session, settings, onBack }) {
  const ui = useUI()
  const sync = useSyncExternalStore(engine.subscribe, engine.getState)
  const [summary, setSummary] = useState(null)
  const [pendingHere, setPendingHere] = useState(0)
  const [feed, setFeed] = useState([])
  const [closing, setClosing] = useState(false)
  const [apply, setApply] = useState(true)
  const closed = session.status === 'closed'

  // Other devices' scans for this session (when online).
  useEffect(() => {
    if (!session.pending) engine.pullScans(session.id).catch(() => {})
  }, [engine, session.id, session.pending])

  const recompute = useCallback(async () => {
    const [s, p] = await Promise.all([engine.sessionSummary(orgId, session.id), engine.pendingForSession(session.id)])
    setSummary(s)
    setPendingHere(p)
  }, [engine, orgId, session.id])

  useEffect(() => {
    recompute()
  }, [recompute, sync.version])

  function push(entry) {
    setFeed(f => [entry, ...f].slice(0, 50))
    beep(entry.kind, settings.sound)
  }

  useEffect(
    () =>
      engine.onResult(r => {
        if (r.kind !== 'scan') return
        setFeed(f =>
          f.map(e => {
            if (e.clientId !== r.client_id) return e
            if (r.result === r.predicted && r.result !== 'unknown') return { ...e, synced: true }
            const map = {
              ok: ['ok', `Synced: ${r.product}`],
              duplicate: ['warn', 'Already counted on another device'],
              unknown: ['error', 'Unknown code'],
              session_closed: ['error', 'Rejected: stocktake was already closed'],
            }
            const [kind, title] = map[r.result] ?? ['error', 'Sync error']
            return { ...e, synced: true, kind, title, detail: r.message || '' }
          }),
        )
      }),
    [engine],
  )

  async function handleScan(code) {
    let r
    try {
      r = await engine.recordScan({ orgId, sessionId: session.id, code })
    } catch (e) {
      return push(makeEntry('error', code, 'NOT SAVED', e.message))
    }
    // ok / unknown scans can be removed again (wrong shelf, stray barcode)
    const base = { clientId: r.client_id, removable: ['ok', 'unknown'].includes(r.result) }
    if (r.result === 'ok') {
      if (r.unit_status === 'in_stock') push({ ...makeEntry('ok', r.code, r.product), ...base })
      else push({ ...makeEntry('warn', r.code, `Found: ${r.product}`, `system says "${r.unit_status}"`), ...base })
    } else if (r.result === 'duplicate') {
      push({ ...makeEntry('warn', r.code, 'Already counted', r.product), ...base })
    } else if (r.result === 'session_closed') {
      push(makeEntry('error', r.code, 'Stocktake is closed'))
    } else {
      push({ ...makeEntry('warn', r.code, 'Not in local list', 'saved — will be checked on sync'), ...base })
    }
  }

  useScanner(handleScan, { ...settings, enabled: !closed && !closing })

  async function remove(entry) {
    const r = await engine.unscan({ orgId, sessionId: session.id, scanId: entry.clientId })
    if (r.result === 'blocked') return ui.toast('This scan can’t be removed (already removed, or the stocktake is closed).', 'error')
    setFeed(f =>
      f.map(e =>
        e.id === entry.id
          ? { ...e, kind: 'warn', undone: true, removable: false, title: `Removed: ${e.title}`, detail: 'not counted — scan it again to count it' }
          : e,
      ),
    )
  }

  const feedActions = e =>
    e.removable && !e.undone && !closed ? (
      <button
        className="ghost small-btn"
        data-testid="remove-scan"
        onClick={ev => {
          ev.currentTarget.blur()
          remove(e)
        }}
      >
        Remove
      </button>
    ) : null

  async function close() {
    const { data, error } = await supabase.rpc('close_count', { p_session: session.id, p_apply: apply })
    if (error) return ui.toast(error.message, 'error')
    setClosing(false)
    await engine.markSessionClosed(session.id)
    await engine.refreshOrg(orgId)
    ui.toast(
      data.applied
        ? `Stocktake finished. ${data.lost} marked lost, ${data.found} returned to stock.`
        : 'Stocktake finished. Stock levels were not changed.',
      'ok',
    )
  }

  const canClose = sync.online && pendingHere === 0
  const pct = summary?.expected ? Math.round((summary.matched / summary.expected) * 100) : 0

  return (
    <>
      <PageHeader
        back={{ label: 'All stocktakes', onClick: onBack }}
        title={session.name}
        description={
          <span className="row" style={{ gap: 8 }}>
            <StatusBadge status={session.status} /> Started {formatDateTime(session.created_at)}
          </span>
        }
        actions={
          !closed && (
            <button className="primary" disabled={!canClose} onClick={() => setClosing(true)}>
              <Icon name="check" /> Finish stocktake
            </button>
          )
        }
      />
      {!closed && !canClose && (
        <div className="notice offline">
          <Icon name="alert" />
          <div>
            {pendingHere > 0
              ? `${pendingHere} scan${pendingHere === 1 ? '' : 's'} of this stocktake still on this device. `
              : ''}
            Finishing needs a connection and every scan synced, so the result includes all devices. You can keep
            counting.
          </div>
        </div>
      )}

      {summary && (
        <Section>
          <div className="progress-row" style={{ marginBottom: 16 }}>
            <strong>
              {summary.matched} of {summary.expected}
            </strong>
            <span className="muted">expected units counted</span>
            <div className="progress">
              <div style={{ width: `${pct}%` }} />
            </div>
            <strong>{pct}%</strong>
          </div>
          <div className="stats">
            <Stat label="Expected in stock" value={summary.expected} />
            <Stat label="Counted" value={summary.matched} tone={summary.matched ? 'ok' : ''} />
            <Stat label="Missing" value={summary.missing.length} tone={summary.missing.length ? 'error' : ''} />
            <Stat label="Found (not expected)" value={summary.extra.length} tone={summary.extra.length ? 'warn' : ''} />
            <Stat label="Unknown codes" value={summary.unknown.length} tone={summary.unknown.length ? 'error' : ''} />
          </div>
        </Section>
      )}

      {!closed && (
        <div className="scan-layout">
          <div className="scan-controls">
            <ScanFlash entry={feed[0]} idle="Ready to count" />
            <ScanInput onScan={handleScan} />
          </div>
          <Section flush title="Scans on this device">
            <div className="feed-panel">
              {feed.length ? (
                <ScanFeed entries={feed} actions={feedActions} />
              ) : (
                <EmptyState icon="scan" title="Start scanning">
                  Every label you scan is counted once, even if several devices scan it.
                </EmptyState>
              )}
            </div>
          </Section>
        </div>
      )}

      {summary && (
        <div className="grid2">
          <UnitList title="Missing" description="Expected in stock but not scanned yet" tone="error" items={summary.missing} empty="Nothing missing." />
          <UnitList
            title="Found"
            description="Scanned, but the system had them as out or lost"
            tone="warn"
            items={summary.extra}
            empty="None."
            showStatus
          />
          {summary.unknown.length > 0 && (
            <Section title="Unknown codes" description="Scanned but not registered — wrong label, or another system’s barcode.">
              <div className="codes">
                {summary.unknown.map(c => (
                  <code key={c}>{c}</code>
                ))}
              </div>
            </Section>
          )}
        </div>
      )}

      {closing && (
        <Modal
          title={`Finish “${session.name}”?`}
          onClose={() => setClosing(false)}
          footer={
            <>
              <button className="secondary" onClick={() => setClosing(false)}>
                Keep counting
              </button>
              <button className="primary" onClick={close}>
                Finish
              </button>
            </>
          }
        >
          <p className="muted">
            {summary?.missing.length ?? 0} units were not scanned and {summary?.extra.length ?? 0} were found that the
            system had as out or lost.
          </p>
          <label className="check">
            <input type="checkbox" checked={apply} onChange={e => setApply(e.target.checked)} />
            <span>
              Update stock: mark missing units as <b>lost</b> and found units as <b>in stock</b>.
            </span>
          </label>
          <div className="notice warn">
            <Icon name="alert" />
            <div>
              Only tick this if you scanned the whole warehouse. A partial count marks everything you didn’t reach as
              lost.
            </div>
          </div>
        </Modal>
      )}
    </>
  )
}

function UnitList({ title, description, tone, items, empty, showStatus }) {
  const byProduct = items.reduce((acc, it) => {
    ;(acc[it.product] ??= []).push(it)
    return acc
  }, {})
  return (
    <section className={`panel unit-list ${tone}`}>
      <div className="panel-head">
        <div>
          <h2>
            {title} <span className="muted">({items.length})</span>
          </h2>
          {description && <p className="panel-desc">{description}</p>}
        </div>
      </div>
      {items.length === 0 ? (
        <p className="muted small">{empty}</p>
      ) : (
        Object.entries(byProduct).map(([product, list]) => (
          <div key={product} className="group">
            <div className="group-title">
              {product} <span className="muted">× {list.length}</span>
            </div>
            <div className="codes">
              {list.map(it => (
                <code key={it.code} title={showStatus ? it.status : undefined}>
                  {it.code}
                  {showStatus && <small> · {it.status}</small>}
                </code>
              ))}
            </div>
          </div>
        ))
      )}
    </section>
  )
}
