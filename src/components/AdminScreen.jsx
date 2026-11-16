import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase.js'

// Owner-only: company name, PIN, devices. Every action is re-checked on the
// server (_require_owner); hiding the tab is only convenience.
export default function AdminScreen({ orgId, orgName, onRenamed }) {
  const [name, setName] = useState(orgName)
  const [status, setStatus] = useState(null)
  const [devices, setDevices] = useState(null)
  const [pin, setPin] = useState('')
  const [pin2, setPin2] = useState('')
  const [kick, setKick] = useState(false)
  const [msg, setMsg] = useState(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const [s, d] = await Promise.all([
      supabase.rpc('pin_status', { p_org: orgId }),
      supabase.rpc('list_devices', { p_org: orgId }),
    ])
    if (s.error || d.error) return setMsg({ type: 'error', text: (s.error || d.error).message })
    setStatus(s.data)
    setDevices(d.data)
  }, [orgId])

  useEffect(() => {
    load()
  }, [load])

  async function rename(e) {
    e.preventDefault()
    const { error } = await supabase.from('orgs').update({ name: name.trim() }).eq('id', orgId)
    if (error) return setMsg({ type: 'error', text: error.message })
    setMsg({ type: 'ok', text: 'Company name saved.' })
    onRenamed()
  }

  async function savePin(e) {
    e.preventDefault()
    if (pin !== pin2) return setMsg({ type: 'error', text: 'The two PINs don’t match.' })
    if (kick && !confirm('Sign out every PIN device? Staff will need the new PIN on each device.')) return
    setBusy(true)
    const { data, error } = await supabase.rpc('set_pin', { p_org: orgId, p_pin: pin, p_remove_devices: kick })
    setBusy(false)
    if (error) return setMsg({ type: 'error', text: error.message })
    setPin('')
    setPin2('')
    setKick(false)
    setMsg({
      type: 'ok',
      text: `PIN saved.${data.removed_devices ? ` ${data.removed_devices} device(s) signed out.` : ''}`,
    })
    load()
  }

  async function remove(d) {
    if (!confirm(`Remove “${d.name}”? That device will need the PIN to get back in.`)) return
    const { error } = await supabase.rpc('remove_device', { p_org: orgId, p_user: d.user_id })
    if (error) return setMsg({ type: 'error', text: error.message })
    load()
  }

  return (
    <div className="stack">
      {msg && <div className={`notice ${msg.type}`}>{msg.text}</div>}

      <form className="card row wrap" onSubmit={rename}>
        <label className="grow">
          Company name
          <input required maxLength={80} value={name} onChange={e => setName(e.target.value)} />
        </label>
        <button className="secondary">Save</button>
      </form>

      <form className="card stack" onSubmit={savePin}>
        <div>
          <h2>Company PIN</h2>
          <p className="muted small">
            {status === null
              ? 'Loading…'
              : status.has_pin
                ? `Set · last changed ${new Date(status.updated_at).toLocaleString()}`
                : 'No PIN yet — staff can’t sign in until you set one.'}
          </p>
        </div>
        <div className="row wrap">
          <label className="grow">
            New PIN (6–12 digits)
            <input
              className="pin-input"
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              pattern="[0-9]{6,12}"
              required
              maxLength={12}
              value={pin}
              onChange={e => setPin(e.target.value.replace(/\D/g, ''))}
            />
          </label>
          <label className="grow">
            Repeat PIN
            <input
              className="pin-input"
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              required
              maxLength={12}
              value={pin2}
              onChange={e => setPin2(e.target.value.replace(/\D/g, ''))}
            />
          </label>
        </div>
        <label className="check">
          <input type="checkbox" checked={kick} onChange={e => setKick(e.target.checked)} />
          <span>Also sign out every PIN device (use this when someone leaves the company)</span>
        </label>
        <p className="muted small">
          Avoid obvious PINs (123456, birthdays). After 5 wrong tries a device is blocked for 15 minutes.
        </p>
        <div className="row end">
          <button className="primary" disabled={busy}>
            {busy ? '…' : status?.has_pin ? 'Change PIN' : 'Set PIN'}
          </button>
        </div>
      </form>

      <div className="card">
        <h2>Devices</h2>
        <p className="muted small">
          Everyone who entered the PIN. Removing a device signs it out; the PIN still works until you change it.
        </p>
        {devices === null ? (
          <p className="muted">Loading…</p>
        ) : (
          <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th className="hide-sm">Type</th>
                <th className="hide-sm">Last active</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {devices.map(d => (
                <tr key={d.user_id}>
                  <td>
                    <strong>{d.name}</strong>
                    {d.role === 'owner' && <span className="pill show-sm"> owner</span>}
                    {d.email && d.email !== d.name && <span className="muted small"> · {d.email}</span>}
                  </td>
                  <td className="hide-sm">{d.role === 'owner' ? <span className="pill">owner</span> : 'PIN device'}</td>
                  <td className="muted small hide-sm">
                    {d.last_seen_at ? new Date(d.last_seen_at).toLocaleString() : new Date(d.joined_at).toLocaleString()}
                  </td>
                  <td className="num">
                    {d.role === 'member' && (
                      <button className="link" onClick={() => remove(d)}>
                        Remove
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>
    </div>
  )
}
