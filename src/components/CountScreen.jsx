import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { useScanner } from '../lib/useScanner.js'
import { beep } from '../lib/beep.js'
import { ScanInput, ScanFlash, ScanFeed, makeEntry } from './ScanParts.jsx'

export default function CountScreen({ orgId, settings }) {
  const [sessions, setSessions] = useState(null)
  const [activeId, setActiveId] = useState(null)
  const [name, setName] = useState('')

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('count_sessions')
      .select('id, name, status, created_at, closed_at')
      .eq('org_id', orgId)
      .order('created_at', { ascending: false })
      .limit(50)
    if (error) alert(error.message)
    else setSessions(data)
  }, [orgId])

  useEffect(() => {
    load()
  }, [load])

  async function create(e) {
    e.preventDefault()
    const { data, error } = await supabase
      .from('count_sessions')
      .insert({ org_id: orgId, name: name.trim() || `Stocktake ${new Date().toLocaleDateString()}` })
      .select('id')
      .single()
    if (error) return alert(error.message)
    setName('')
    await load()
    setActiveId(data.id)
  }

  const active = sessions?.find(s => s.id === activeId)
  if (active) {
    return (
      <CountSession
        session={active}
        settings={settings}
        onBack={() => {
          setActiveId(null)
          load()
        }}
        onClosed={load}
      />
    )
  }

  return (
    <div className="stack">
      <form className="card row wrap" onSubmit={create}>
        <label className="grow">
          New stocktake
          <input placeholder={`Stocktake ${new Date().toLocaleDateString()}`} value={name} onChange={e => setName(e.target.value)} />
        </label>
        <button className="primary">Start counting</button>
      </form>

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
              <span className="muted small">{new Date(s.created_at).toLocaleString()}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function CountSession({ session, settings, onBack, onClosed }) {
  const [summary, setSummary] = useState(null)
  const [feed, setFeed] = useState([])
  const [closing, setClosing] = useState(false)
  const [apply, setApply] = useState(true)
  const [closed, setClosed] = useState(session.status === 'closed')
  const timer = useRef(null)

  const refresh = useCallback(async () => {
    const { data, error } = await supabase.rpc('count_summary', { p_session: session.id })
    if (!error) setSummary(data)
  }, [session.id])

  useEffect(() => {
    refresh()
    return () => clearTimeout(timer.current)
  }, [refresh])

  function scheduleRefresh() {
    clearTimeout(timer.current)
    timer.current = setTimeout(refresh, 300)
  }

  function push(entry) {
    setFeed(f => [entry, ...f].slice(0, 50))
    beep(entry.kind, settings.sound)
  }

  async function handleScan(code) {
    const { data, error } = await supabase.rpc('record_scan', { p_session: session.id, p_code: code })
    if (error) return push(makeEntry('error', code, 'Error', error.message))
    if (data.result === 'ok') {
      if (data.unit_status === 'in_stock') push(makeEntry('ok', code, data.product))
      else push(makeEntry('warn', code, `Found: ${data.product}`, `system says "${data.unit_status}"`))
    } else if (data.result === 'duplicate') {
      push(makeEntry('warn', code, 'Already counted', data.product))
    } else {
      push(makeEntry('error', code, 'Unknown code', 'Not in your inventory'))
    }
    scheduleRefresh()
  }

  useScanner(handleScan, { ...settings, enabled: !closed && !closing })

  async function close() {
    const { data, error } = await supabase.rpc('close_count', { p_session: session.id, p_apply: apply })
    if (error) return alert(error.message)
    setClosing(false)
    setClosed(true)
    onClosed()
    if (data.applied) alert(`Stocktake closed. ${data.lost} marked lost, ${data.found} returned to stock.`)
  }

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
          <button className="primary" onClick={() => setClosing(true)}>
            Finish stocktake
          </button>
        )}
      </div>

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
          <UnitList
            title="Found (system had them as out / lost)"
            tone="warn"
            items={summary.extra}
            empty="None."
            showStatus
          />
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
              lost.
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
