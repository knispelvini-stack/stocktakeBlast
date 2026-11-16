import { useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { useScanner } from '../lib/useScanner.js'
import { beep } from '../lib/beep.js'
import { ScanInput, ScanFlash, ScanFeed, makeEntry } from './ScanParts.jsx'

const STATUS_LABEL = { in_stock: 'in stock', out: 'out', lost: 'lost', retired: 'retired' }

export default function MoveScreen({ orgId, settings }) {
  const [direction, setDirection] = useState('out')
  const [reference, setReference] = useState('')
  const [feed, setFeed] = useState([])
  const [counts, setCounts] = useState({ ok: 0, problems: 0 })

  function push(entry) {
    setFeed(f => [entry, ...f].slice(0, 50))
    setCounts(c => (entry.kind === 'ok' ? { ...c, ok: c.ok + 1 } : { ...c, problems: c.problems + 1 }))
    beep(entry.kind, settings.sound)
  }

  async function handleScan(code) {
    const { data, error } = await supabase.rpc('move_unit', {
      p_org: orgId,
      p_code: code,
      p_direction: direction,
      p_reference: reference || null,
    })
    if (error) return push(makeEntry('error', code, 'Error', error.message))

    const verb = direction === 'out' ? 'Checked out' : 'Checked in'
    switch (data.result) {
      case 'ok':
        return push(
          makeEntry('ok', code, `${verb}: ${data.product}`, data.previous === 'lost' ? '(was marked lost — found!)' : ''),
        )
      case 'already':
        return push(makeEntry('warn', code, `Already ${STATUS_LABEL[data.status]}`, data.product))
      case 'retired':
        return push(makeEntry('error', code, 'Retired unit', data.product))
      default:
        return push(makeEntry('error', code, 'Unknown code', 'Not in your inventory'))
    }
  }

  useScanner(handleScan, settings)

  return (
    <div className="stack">
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

      <ScanFlash
        entry={feed[0]}
        idle={direction === 'out' ? 'Ready to check OUT' : 'Ready to check IN'}
      />

      <div className="row muted small">
        <span>✓ {counts.ok} moved</span>
        <span>⚠ {counts.problems} need attention</span>
      </div>

      <ScanInput onScan={handleScan} />
      <ScanFeed entries={feed} />
    </div>
  )
}
