import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import Icon from './ui/Icon.jsx'
import { Section, Badge, useUI, timeAgo, formatDateTime } from './ui/ui.jsx'

// Owner-only settings. Every action is re-checked on the server
// (_require_owner); hiding these sections from staff is only convenience.

export function CompanySettings({ orgId, orgName, onRenamed }) {
  const ui = useUI()
  const [name, setName] = useState(orgName)
  const [saving, setSaving] = useState(false)
  const dirty = name.trim() && name.trim() !== orgName

  async function rename(e) {
    e.preventDefault()
    setSaving(true)
    const { error } = await supabase.from('orgs').update({ name: name.trim() }).eq('id', orgId)
    setSaving(false)
    if (error) return ui.toast(error.message, 'error')
    ui.toast('Company name saved.', 'ok')
    onRenamed()
  }

  return (
    <Section title="Company" description="Shown in the app header and on every device.">
      <form onSubmit={rename} className="stack" style={{ gap: 14 }}>
        <label>
          Company name
          <input required maxLength={80} value={name} onChange={e => setName(e.target.value)} />
        </label>
        <div className="row end">
          <button className="primary" disabled={!dirty || saving}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </form>
    </Section>
  )
}

export function AccessSettings({ orgId }) {
  const ui = useUI()
  const [status, setStatus] = useState(null)
  const [devices, setDevices] = useState(null)
  const [pin, setPin] = useState('')
  const [pin2, setPin2] = useState('')
  const [kick, setKick] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const [s, d] = await Promise.all([
      supabase.rpc('pin_status', { p_org: orgId }),
      supabase.rpc('list_devices', { p_org: orgId }),
    ])
    if (s.error || d.error) return ui.toast((s.error || d.error).message, 'error')
    setStatus(s.data)
    setDevices(d.data)
  }, [orgId, ui])

  useEffect(() => {
    load()
  }, [load])

  async function savePin(e) {
    e.preventDefault()
    if (pin !== pin2) return ui.toast('The two PINs don’t match.', 'error')
    if (kick) {
      const ok = await ui.confirm({
        title: 'Sign out every PIN device?',
        body: 'Staff will need the new PIN on each device. Use this when someone leaves the company.',
        confirmLabel: 'Change PIN and sign out devices',
        danger: true,
      })
      if (!ok) return
    }
    setBusy(true)
    const { data, error } = await supabase.rpc('set_pin', { p_org: orgId, p_pin: pin, p_remove_devices: kick })
    setBusy(false)
    if (error) return ui.toast(error.message, 'error')
    setPin('')
    setPin2('')
    setKick(false)
    ui.toast(`PIN saved.${data.removed_devices ? ` ${data.removed_devices} device(s) signed out.` : ''}`, 'ok')
    load()
  }

  async function remove(d) {
    const ok = await ui.confirm({
      title: `Remove “${d.name}”?`,
      body: 'That device is signed out and will need the company PIN to get back in. The PIN itself keeps working until you change it.',
      confirmLabel: 'Remove device',
      danger: true,
    })
    if (!ok) return
    const { error } = await supabase.rpc('remove_device', { p_org: orgId, p_user: d.user_id })
    if (error) return ui.toast(error.message, 'error')
    ui.toast(`${d.name} removed.`, 'ok')
    load()
  }

  return (
    <>
      <Section
        title="Company PIN"
        description={
          status === null
            ? 'Loading…'
            : status.has_pin
              ? `Staff sign in with this PIN · last changed ${formatDateTime(status.updated_at)}`
              : 'No PIN yet — staff can’t sign in until you set one.'
        }
        actions={status && (status.has_pin ? <Badge tone="ok">Active</Badge> : <Badge tone="warn">Not set</Badge>)}
      >
        <form onSubmit={savePin} className="stack" style={{ gap: 14 }}>
          <div className="form-row">
            <label>
              New PIN
              <input
                className="pin-input"
                type="password"
                inputMode="numeric"
                autoComplete="new-password"
                pattern="[0-9]{6,12}"
                title="6 to 12 digits"
                required
                maxLength={12}
                value={pin}
                onChange={e => setPin(e.target.value.replace(/\D/g, ''))}
              />
              <span className="hint">6–12 digits. Avoid obvious ones (123456, birthdays).</span>
            </label>
            <label>
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
            <span>
              Also sign out every PIN device
              <span className="hint" style={{ display: 'block' }}>
                Use this when someone leaves the company.
              </span>
            </span>
          </label>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="hint">
              <Icon name="shield" size={13} /> 5 wrong tries block a device for 15 minutes.
            </span>
            <button className="primary" disabled={busy}>
              {busy ? 'Saving…' : status?.has_pin ? 'Change PIN' : 'Set PIN'}
            </button>
          </div>
        </form>
      </Section>

      <Section flush title="Devices" description="Everyone who signed in. Removing a device signs it out.">
        {devices === null ? (
          <p className="muted" style={{ padding: 20 }}>
            Loading…
          </p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th className="hide-sm">Type</th>
                  <th className="hide-sm">Last active</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {devices.map(d => (
                  <tr key={d.user_id}>
                    <td className="primary-cell">
                      {d.name}
                      {d.role === 'owner' && (
                        <span className="show-sm">
                          <Badge tone="accent">Owner</Badge>
                        </span>
                      )}
                      {d.email && d.email !== d.name && <div className="muted small">{d.email}</div>}
                    </td>
                    <td className="hide-sm">{d.role === 'owner' ? <Badge tone="accent">Owner</Badge> : <span className="muted">PIN device</span>}</td>
                    <td className="muted small hide-sm" title={d.last_seen_at || d.joined_at}>
                      {timeAgo(d.last_seen_at || d.joined_at)}
                    </td>
                    <td className="num">
                      {d.role === 'member' && (
                        <button className="link danger-text" onClick={() => remove(d)}>
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
      </Section>
    </>
  )
}
