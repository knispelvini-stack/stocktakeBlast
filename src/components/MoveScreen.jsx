import { useEffect, useState, useSyncExternalStore } from 'react'
import { useScanner } from '../lib/useScanner.js'
import { beep } from '../lib/beep.js'
import { ScanInput, ScanFlash, ScanFeed, makeEntry } from './ScanParts.jsx'
import Icon from './ui/Icon.jsx'
import { PageHeader, Section, Stat, EmptyState } from './ui/ui.jsx'

const STATUS_LABEL = { in_stock: 'in stock', out: 'out', lost: 'lost', retired: 'retired' }

function entryFor(r, direction, vehicle) {
  const verb = direction === 'out' ? (vehicle ? `On ${vehicle.name}` : 'Checked out') : 'Checked in'
  switch (r.result) {
    case 'ok':
      return makeEntry('ok', r.code, `${verb}: ${r.product}`, r.previous === 'lost' ? '(was marked lost — found!)' : '')
    case 'already':
      return makeEntry('warn', r.code, `Already ${STATUS_LABEL[r.status]}`, r.product)
    case 'retired':
      return makeEntry('error', r.code, 'Retired unit', r.product)
    default:
      // The local list may be out of date (e.g. labels printed on another
      // device). The scan is still queued; the server decides on sync.
      return makeEntry('warn', r.code, 'Not in local list', 'saved — will be checked on sync')
  }
}

export default function MoveScreen({ engine, orgId, settings }) {
  const sync = useSyncExternalStore(engine.subscribe, engine.getState)
  const [direction, setDirection] = useState('out')
  const [reference, setReference] = useState('')
  const [feed, setFeed] = useState([])
  const [counts, setCounts] = useState({ ok: 0, problems: 0 })
  const [vehicles, setVehicles] = useState([])
  const [vehicleId, setVehicleId] = useState('')
  const [units, setUnits] = useState([])

  // Vehicles + units come from the local cache, so van labels scan offline too.
  useEffect(() => {
    engine.listVehicles(orgId).then(setVehicles)
    engine.listUnits(orgId).then(setUnits)
  }, [engine, orgId, sync.version])
  const vehicle = vehicles.find(v => v.id === vehicleId)

  // When the server's answer differs from what we showed, update that line.
  useEffect(
    () =>
      engine.onResult(r => {
        if (r.kind !== 'move') return
        setFeed(f =>
          f.map(e => {
            if (e.clientId !== r.client_id) return e
            const synced = { ...e, synced: true }
            // "unknown" was only a guess from the local list; once the server agrees it is final.
            if (r.result === 'unknown') return { ...synced, kind: 'error', title: 'Unknown code', detail: 'not in your inventory' }
            if (r.result === r.predicted) return synced
            if (r.result === 'ok') return { ...synced, kind: 'ok', title: `Synced: ${r.product}`, detail: 'confirmed by server' }
            if (r.result === 'unknown') return { ...synced, kind: 'error', title: 'Unknown code', detail: 'not in your inventory' }
            if (r.result === 'late')
              return { ...synced, kind: 'warn', title: 'Not applied', detail: 'a newer scan of this unit exists — see History' }
            if (r.result === 'already')
              return { ...synced, kind: 'warn', title: `Already ${STATUS_LABEL[r.status]}`, detail: 'another device got there first' }
            return { ...synced, kind: 'error', title: 'Sync error', detail: r.message || r.result }
          }),
        )
      }),
    [engine],
  )

  function push(entry) {
    setFeed(f => [entry, ...f].slice(0, 50))
    beep(entry.kind, settings.sound)
  }

  async function handleScan(code) {
    // A vehicle label selects the vehicle; it is not a movement.
    if (code.startsWith('VEH-')) {
      const v = vehicles.find(x => x.code === code)
      if (!v) return push(makeEntry('error', code, 'Unknown vehicle', 'not registered (or this device has not synced yet)'))
      if (!v.active) return push(makeEntry('error', code, `${v.name} is inactive`, 'reactivate it in Settings → Vehicles'))
      setVehicleId(v.id)
      return push(
        makeEntry('ok', code, `${direction === 'out' ? 'Loading' : 'Unloading'} ${v.name}`, 'now scan the items'),
      )
    }
    try {
      const r = await engine.recordMove({ orgId, code, direction, reference, vehicleId: vehicleId || null })
      const entry = { ...entryFor(r, direction, vehicle), clientId: r.client_id }
      push(entry)
      setCounts(c => (entry.kind === 'ok' ? { ...c, ok: c.ok + 1 } : { ...c, problems: c.problems + 1 }))
    } catch (e) {
      // IndexedDB failure (storage full / blocked) — the only way a scan can be lost.
      setFeed(f => [makeEntry('error', code, 'NOT SAVED', e.message), ...f].slice(0, 50))
      beep('error', settings.sound)
    }
  }

  useScanner(handleScan, settings)

  // Suggest references already in use (e.g. "Van 2") — works offline.
  const [refs, setRefs] = useState([])
  useEffect(() => {
    engine.listUnits(orgId).then(us => setRefs([...new Set(us.map(u => u.last_ref).filter(Boolean))].sort()))
  }, [engine, orgId, sync.version])

  const setDir = (d, e) => {
    setDirection(d)
    e.currentTarget.blur()
  }

  return (
    <>
      <PageHeader
        title="Check out / in"
        description="Scan labels to record items leaving or returning. No need to click — just scan."
      />
      {!sync.online && (
        <div className="notice offline">
          <Icon name="wifiOff" />
          <div>
            <strong>You’re offline.</strong> Keep scanning — everything is saved on this device and sent automatically
            when the connection is back.
          </div>
        </div>
      )}
      <div className={`scan-layout mode-${direction}`}>
        <div className="scan-controls">
          <div className="segmented" role="group" aria-label="Direction">
            <button className={direction === 'out' ? 'active out' : ''} aria-pressed={direction === 'out'} onClick={e => setDir('out', e)}>
              <Icon name="arrowUp" /> Check OUT
            </button>
            <button className={direction === 'in' ? 'active in' : ''} aria-pressed={direction === 'in'} onClick={e => setDir('in', e)}>
              <Icon name="arrowDown" /> Check IN
            </button>
          </div>
          <label>
            Vehicle <span className="hint">scan the van’s label, or pick it</span>
            <select value={vehicleId} onChange={e => setVehicleId(e.target.value)} data-testid="move-vehicle">
              <option value="">No vehicle</option>
              {vehicles
                .filter(v => v.active || v.id === vehicleId)
                .map(v => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                    {v.plate ? ` · ${v.plate}` : ''}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Reference <span className="hint">optional — e.g. job or customer</span>
            <input
              list="move-refs"
              placeholder="e.g. Job 1043 · Smith party"
              value={reference}
              onChange={e => setReference(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && e.currentTarget.blur()}
            />
            <datalist id="move-refs">
              {refs.map(r => (
                <option key={r} value={r} />
              ))}
            </datalist>
          </label>

          <ScanFlash entry={feed[0]} idle={direction === 'out' ? 'Ready to check OUT' : 'Ready to check IN'} />
          <ScanInput onScan={handleScan} />
        </div>

        <div className="stack">
        {vehicle && <VehicleLoad vehicle={vehicle} units={units} direction={direction} />}
        <Section flush title="This session" description="Scans on this device since you opened this screen">
          <div className="session-stats" style={{ padding: '16px 16px 0' }}>
            <Stat label="Moved" value={counts.ok} tone={counts.ok ? 'ok' : ''} />
            <Stat label="Need attention" value={counts.problems} tone={counts.problems ? 'warn' : ''} />
          </div>
          <div className="feed-panel" style={{ marginTop: 16, borderTop: '1px solid var(--border)' }}>
            {feed.length ? (
              <ScanFeed entries={feed} />
            ) : (
              <EmptyState icon="scan" title="No scans yet">
                Scanned items appear here with their sync status.
              </EmptyState>
            )}
          </div>
        </Section>
        </div>
      </div>
    </>
  )
}

// What's on the selected vehicle right now. Loading: what's on board.
// Unloading: what still has to come back off it.
function VehicleLoad({ vehicle, units, direction }) {
  const on = units.filter(u => u.status === 'out' && u.vehicle_id === vehicle.id).sort((a, b) => a.code.localeCompare(b.code))
  const byProduct = on.reduce((m, u) => ((m[u.product] ??= []).push(u), m), {})
  return (
    <Section
      flush
      title={
        <span className="row" style={{ gap: 8 }}>
          <Icon name="truck" /> {direction === 'out' ? `On ${vehicle.name} now` : `Still out with ${vehicle.name}`} ({on.length})
        </span>
      }
      description={direction === 'out' ? 'Everything checked out on this vehicle and not back yet' : 'Scan each one as it comes off. What’s left here didn’t come back.'}
    >
      <div data-testid="vehicle-load">
        {on.length === 0 ? (
          <EmptyState icon="check" title={direction === 'out' ? 'Nothing loaded yet' : 'Everything is back'} />
        ) : (
          <div style={{ padding: '14px 20px' }}>
            {Object.entries(byProduct).map(([product, list]) => (
              <div className="group" key={product}>
                <div className="group-title">
                  {product} <span className="muted">× {list.length}</span>
                </div>
                <div className="codes">
                  {list.map(u => (
                    <code key={u.id}>{u.code}</code>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Section>
  )
}
