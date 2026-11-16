import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { supabase } from '../lib/supabase.js'
import { useScanner } from '../lib/useScanner.js'
import { beep } from '../lib/beep.js'
import { ScanInput, ScanFlash, ScanFeed, makeEntry } from './ScanParts.jsx'

export default function CountScreen({ engine, orgId, settings }) {
  const sync = useSyncExternalStore(engine.subscribe, engine.getState)
  const [sessions, setSessions] = useState(null)
  const [activeId, setActiveId] = useState(null)
  const [name, setName] = useState('')

  useEffect(() => {
    engine.listSessions(orgId).then(setSessions)
  }, [engine, orgId, sync.version])

  async function create(e) {
    e.preventDefault()
    const id = await engine.createSession({
      orgId,
      name: name.trim() || `Stocktake ${new Date().toLocaleDateString()}`,
    })
    setName('')
    setActiveId(id)
  }

  const active = sessions?.find(s => s.id === activeId)
  if (active) {
    return <CountSession engine={engine} orgId={orgId} session={active} settings={settings} onBack={() => setActiveId(null)} />
  }

  return (
    <div className="stack">
      <form className="card row wrap" onSubmit={create}>
        <label className="grow">
          New stocktake
          <input
            placeholder={`Stocktake ${new Date().toLocaleDateString()}`}
            value={name}
            onChange={e => setName(e.target.value)}
          />
        </label>
        <button className="primary">Start counting</button>
      </form>
      {!sync.online && <p className="muted small">Offline: you can start and count a stocktake now; it syncs later.</p>}

      {sessions === null ? (
        <p className="muted">Loading…</p>
      ) : sessions.length === 0 ? (
        <p className="muted">No stocktakes yet. Start one above, then scan every label you can find.</p>
      ) : (
        <ul className="list">
          {sessions.map(s => (
            <li key={s.id} onClick={() => setActiveId(s.id)} className="clickable">
              <strong>{s.name}</strong>
              <span className={`pill ${s.status}`}>{s.status}</span>
              {s.pending && <span className="pill pending">not synced</span>}
              <span className="muted small">{new Date(s.created_at).toLocaleString()}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function CountSession({ engine, orgId, session, settings, onBack }) {
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
            if (r.result === r.predicted) return { ...e, synced: true }
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
    const base = { clientId: r.client_id }
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

  async function close() {
    const { data, error } = await supabase.rpc('close_count', { p_session: session.id, p_apply: apply })
    if (error) return alert(error.message)
    setClosing(false)
    await engine.markSessionClosed(session.id)
    await engine.refreshOrg(orgId)
    if (data.applied) alert(`Stocktake closed. ${data.lost} marked lost, ${data.found} returned to stock.`)
  }

  const canClose = sync.online && pendingHere === 0
  const pct = summary?.expected ? Math.round((summary.matched / summary.expected) * 100) : 0

  return (
    <div className="stack">
      <div className="row wrap">
        <button className="ghost" onClick={onBack}>
          ← All stocktakes
        </button>
        <h2 className="grow">{session.name}</h2>
        {closed ? (
          <span className="pill closed">closed</span>
        ) : (
          <button className="primary" disabled={!canClose} onClick={() => setClosing(true)}>
            Finish stocktake
          </button>
        )}
      </div>
      {!closed && !canClose && (
        <div className="notice offline">
          {pendingHere > 0
            ? `${pendingHere} scan${pendingHere === 1 ? '' : 's'} of this stocktake still on this device. `
            : ''}
          Finishing needs a connection and every scan synced, so the result includes all devices. You can keep counting.
        </div>
      )}

      {summary && (
        <div className="kpis">
          <Kpi label="Expected in stock" value={summary.expected} />
          <Kpi label="Counted" value={summary.matched} sub={`${pct}%`} />
          <Kpi label="Missing" value={summary.missing.length} tone={summary.missing.length ? 'error' : ''} />
          <Kpi label="Found (not expected)" value={summary.extra.length} tone={summary.extra.length ? 'warn' : ''} />
          <Kpi label="Unknown codes" value={summary.unknown.length} tone={summary.unknown.length ? 'error' : ''} />
        </div>
      )}
      {summary && (
        <div className="progress">
          <div style={{ width: `${pct}%` }} />
        </div>
      )}

      {!closed && (
        <>
          <ScanFlash entry={feed[0]} idle="Ready to count" />
          <ScanInput onScan={handleScan} />
        </>
      )}

      <ScanFeed entries={feed} />

      {summary && (
        <div className="grid2">
          <UnitList title="Missing" tone="error" items={summary.missing} empty="Nothing missing." />
          <UnitList title="Found (system had them as out / lost)" tone="warn" items={summary.extra} empty="None." showStatus />
          {summary.unknown.length > 0 && (
            <div className="card">
              <h3>Unknown codes</h3>
              <p className="muted small">Scanned but not registered — wrong label, or another system's barcode.</p>
              <div className="codes">
                {summary.unknown.map(c => (
                  <code key={c}>{c}</code>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {closing && (
        <div className="modal-backdrop" onClick={() => setClosing(false)}>
          <div className="card modal" onClick={e => e.stopPropagation()}>
            <h2>Finish “{session.name}”?</h2>
            <p>
              {summary?.missing.length ?? 0} units were not scanned and {summary?.extra.length ?? 0} were found that the
              system had as out or lost.
            </p>
            <label className="check">
              <input type="checkbox" checked={apply} onChange={e => setApply(e.target.checked)} />
              <span>
                Update stock: mark missing units as <b>lost</b> and found units as <b>in stock</b>.
              </span>
            </label>
            <p className="muted small">
              Only tick this if you scanned the whole warehouse. A partial count would mark everything you didn’t reach as
              lost. Other devices must have synced their scans first.
            </p>
            <div className="row end">
              <button className="ghost" onClick={() => setClosing(false)}>
                Keep counting
              </button>
              <button className="primary" onClick={close}>
                Finish
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Kpi({ label, value, sub, tone = '' }) {
  return (
    <div className={`kpi ${tone}`}>
      <div className="kpi-value">
        {value}
        {sub && <small> {sub}</small>}
      </div>
      <div className="kpi-label">{label}</div>
    </div>
  )
}

function UnitList({ title, tone, items, empty, showStatus }) {
  const [open, setOpen] = useState(true)
  const byProduct = items.reduce((acc, it) => {
    ;(acc[it.product] ??= []).push(it)
    return acc
  }, {})
  return (
    <div className={`card unit-list ${tone}`}>
      <h3 onClick={() => setOpen(!open)} className="clickable">
        {title} <span className="muted">({items.length})</span>
      </h3>
      {open &&
        (items.length === 0 ? (
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
        ))}
    </div>
  )
}
