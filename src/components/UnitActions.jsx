import { useState } from 'react'
import { supabase } from '../lib/supabase.js'
import Icon from './ui/Icon.jsx'
import { Modal, Badge, StatusBadge, useUI, timeAgo } from './ui/ui.jsx'

// Unit actions shared by Inventory and Check out / in. All go through
// SECURITY DEFINER RPCs (set_unit_condition / set_unit_status) — the client
// has no write access to units. They need a connection.

export function ConditionBadge({ unit }) {
  if (unit.condition !== 'damaged') return null
  return (
    <span title={unit.condition_note || 'Damaged'} data-testid="damaged-badge">
      <Badge tone="error">damaged</Badge>
    </span>
  )
}

export function DamageModal({ code, onClose, onSave }) {
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  async function submit(e) {
    e.preventDefault()
    setBusy(true)
    await onSave(note.trim())
    setBusy(false)
  }
  return (
    <form onSubmit={submit}>
      <Modal
        title={`Report damage · ${code}`}
        description="It stays in the system and can still be scanned, but shows as damaged (not available) until it is marked repaired."
        onClose={onClose}
        size="sm"
        footer={
          <>
            <button type="button" className="secondary" onClick={onClose}>
              Cancel
            </button>
            <button className="primary" disabled={busy || !note.trim()}>
              {busy ? 'Saving…' : 'Mark damaged'}
            </button>
          </>
        }
      >
        <label>
          What’s wrong?
          <input
            value={note}
            maxLength={200}
            placeholder="e.g. torn seam on the left tower"
            onChange={e => setNote(e.target.value)}
            data-testid="damage-note"
          />
        </label>
      </Modal>
    </form>
  )
}

export function useUnitActions({ engine, orgId, onChanged }) {
  const ui = useUI()
  async function done(msg) {
    ui.toast(msg, 'ok')
    await onChanged?.()
    engine.pullUnits(orgId).catch(() => {})
  }
  return {
    async setCondition(unit, condition, note = null) {
      const { error } = await supabase.rpc('set_unit_condition', { p_unit: unit.id, p_condition: condition, p_note: note })
      if (error) {
        ui.toast(error.code ? error.message : 'Needs a connection — try again when online.', 'error')
        return false
      }
      await done(condition === 'damaged' ? `${unit.code} marked damaged.` : `${unit.code} marked repaired.`)
      return true
    },
    async setStatus(unit, status) {
      const ask = {
        retired: {
          title: `Retire ${unit.code}?`,
          body: 'Use this for a unit that was sold, scrapped or written off. It will no longer be expected in stocktakes. You can restore it later.',
          confirmLabel: 'Retire unit',
        },
        lost: {
          title: `Mark ${unit.code} as lost?`,
          body: 'For a piece a customer kept or that went missing. It is no longer expected in stocktakes. If it turns up, just scan it in.',
          confirmLabel: 'Mark lost',
        },
      }[status]
      if (ask && !(await ui.confirm({ ...ask, danger: true }))) return false
      const { error } = await supabase.rpc('set_unit_status', { p_unit: unit.id, p_status: status })
      if (error) {
        ui.toast(error.code ? error.message : 'Needs a connection — try again when online.', 'error')
        return false
      }
      await done(
        status === 'retired' ? `${unit.code} retired.` : status === 'lost' ? `${unit.code} marked lost.` : `${unit.code} restored to stock.`,
      )
      return true
    },
  }
}

// Everything you can do to one unit, from Inventory.
export function UnitModal({ engine, orgId, unit, onClose, onChanged, onShowHistory }) {
  const actions = useUnitActions({ engine, orgId, onChanged })
  const [damaging, setDamaging] = useState(false)
  const run = async p => (await p) && onClose()

  if (damaging)
    return (
      <DamageModal
        code={unit.code}
        onClose={() => setDamaging(false)}
        onSave={note => run(actions.setCondition(unit, 'damaged', note))}
      />
    )

  const retired = unit.status === 'retired'
  return (
    <Modal title={unit.code} onClose={onClose} size="sm">
      <div className="stack" data-testid="unit-modal">
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <StatusBadge status={unit.status} />
          <ConditionBadge unit={unit} />
          <span className="muted small">{unit.last_moved_at ? `moved ${timeAgo(unit.last_moved_at)}` : 'never moved'}</span>
        </div>
        {unit.condition === 'damaged' && unit.condition_note && <p className="muted small">Damage: {unit.condition_note}</p>}
        <div className="unit-actions">
          {!retired &&
            (unit.condition === 'damaged' ? (
              <button className="secondary" onClick={() => run(actions.setCondition(unit, 'ok'))}>
                <Icon name="check" /> Mark repaired
              </button>
            ) : (
              <button className="secondary" onClick={() => setDamaging(true)}>
                <Icon name="alert" /> Report damage
              </button>
            ))}
          {['in_stock', 'out'].includes(unit.status) && (
            <button className="secondary" onClick={() => run(actions.setStatus(unit, 'lost'))}>
              <Icon name="x" /> Mark lost
            </button>
          )}
          {retired ? (
            <button className="secondary" onClick={() => run(actions.setStatus(unit, 'in_stock'))}>
              <Icon name="refresh" /> Restore
            </button>
          ) : (
            <button className="secondary danger-text" onClick={() => run(actions.setStatus(unit, 'retired'))}>
              Retire
            </button>
          )}
          <button
            className="ghost"
            onClick={() => {
              onClose()
              onShowHistory(unit.code)
            }}
          >
            <Icon name="activity" /> Movement history
          </button>
        </div>
      </div>
    </Modal>
  )
}
