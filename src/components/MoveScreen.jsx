import { useEffect, useState, useSyncExternalStore } from 'react'
import { useScanner } from '../lib/useScanner.js'
import { beep } from '../lib/beep.js'
import { ScanInput, ScanFlash, ScanFeed, makeEntry } from './ScanParts.jsx'

const STATUS_LABEL = { in_stock: 'in stock', out: 'out', lost: 'lost', retired: 'retired' }

function entryFor(r, direction) {
  const verb = direction === 'out' ? 'Checked out' : 'Checked in'
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

  // When the server's answer differs from what we showed, update that line.
  useEffect(
    () =>
      engine.onResult(r => {
        if (r.kind !== 'move') return
        setFeed(f =>
          f.map(e => {
            if (e.clientId !== r.client_id) return e
            const synced = { ...e, synced: true }
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

  async function handleScan(code) {
    try {
      const r = await engine.recordMove({ orgId, code, direction, reference })
      const entry = { ...entryFor(r, direction), clientId: r.client_id }
      setFeed(f => [entry, ...f].slice(0, 50))
      setCounts(c => (entry.kind === 'ok' ? { ...c, ok: c.ok + 1 } : { ...c, problems: c.problems + 1 }))
      beep(entry.kind, settings.sound)
    } catch (e) {
      // IndexedDB failure (storage full / blocked) — the only way a scan can be lost.
      setFeed(f => [makeEntry('error', code, 'NOT SAVED', e.message), ...f].slice(0, 50))
      beep('error', settings.sound)
    }
  }

  useScanner(handleScan, settings)

  return (
    <div className="stack">
      {!sync.online && (
        <div className="notice offline">
          You’re offline. Keep scanning — everything is saved on this device and sent automatically when the connection is
          back.
        </div>
      )}
      <div className="row wrap">
        <div className="segmented">
          <button
            className={direction === 'out' ? 'active out' : ''}
            onClick={e => {
              setDirection('out')
              e.currentTarget.blur()
            }}
          >
            ↑ Check OUT
          </button>
          <button
            className={direction === 'in' ? 'active in' : ''}
            onClick={e => {
              setDirection('in')
              e.currentTarget.blur()
            }}
          >
            ↓ Check IN
          </button>
        </div>
        <label className="grow">
          Reference (optional)
          <input
            placeholder="e.g. Van 2 · Job 1043"
            value={reference}
            onChange={e => setReference(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && e.currentTarget.blur()}
          />
        </label>
      </div>

      <ScanFlash entry={feed[0]} idle={direction === 'out' ? 'Ready to check OUT' : 'Ready to check IN'} />

      <div className="row muted small">
        <span>✓ {counts.ok} moved</span>
        <span>⚠ {counts.problems} need attention</span>
      </div>

      <ScanInput onScan={handleScan} />
      <ScanFeed entries={feed} />
    </div>
  )
}
