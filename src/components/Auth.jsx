import { useState } from 'react'
import { supabase } from '../lib/supabase.js'
import Icon from './ui/Icon.jsx'

function BrandMark() {
  return (
    <div className="auth-brand">
      <div className="logo-mark">
        <Icon name="barcode" size={18} strokeWidth={2.2} />
      </div>
      <div className="logo-text">
        stocktakeBlast
        <small>Inventory</small>
      </div>
    </div>
  )
}

const NAME_KEY = 'stb.deviceName'

function savedName() {
  try {
    return localStorage.getItem(NAME_KEY) || ''
  } catch {
    return ''
  }
}

// Entry screen. Staff: name + company PIN (each device signs in anonymously,
// the server checks the PIN). Owner: email + password, for the Admin tab.
export default function Auth({ onBusy, onJoined }) {
  const [mode, setMode] = useState('pin')
  const [name, setName] = useState(savedName)
  const [pin, setPin] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)

  async function enterPin(e) {
    e.preventDefault()
    setMsg(null)
    setBusy(true)
    onBusy(true)
    try {
      const { data } = await supabase.auth.getSession()
      if (!data.session) {
        const { error } = await supabase.auth.signInAnonymously()
        if (error) {
          setMsg(
            /disabled|not allowed/i.test(error.message)
              ? 'PIN sign-in is not enabled yet. The owner must turn on “Anonymous sign-ins” in Supabase.'
              : error.message,
          )
          return
        }
      }
      const { data: orgId, error } = await supabase.rpc('join_with_pin', { p_pin: pin, p_name: name })
      if (error) {
        setMsg(!error.code ? 'No connection. The first sign-in on a device needs internet.' : error.message)
        return
      }
      if (!orgId) {
        setPin('')
        setMsg('Wrong PIN.')
        return
      }
      try {
        localStorage.setItem(NAME_KEY, name.trim())
      } catch {
        /* ignore */
      }
      await onJoined()
    } finally {
      setBusy(false)
      onBusy(false)
    }
  }

  async function ownerSignIn(e) {
    e.preventDefault()
    setMsg(null)
    setBusy(true)
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    setBusy(false)
    if (error) setMsg(error.message)
  }

  return (
    <div className="auth-page">
      {mode === 'pin' ? (
        <form className="card narrow" onSubmit={enterPin}>
          <BrandMark />
          <div>
            <h1>Sign in to this device</h1>
            <p className="muted" style={{ marginTop: 6 }}>
              Enter your name and the company PIN. You only do this once on each device.
            </p>
          </div>
          <label>
            Your name
            <input required maxLength={40} autoComplete="name" value={name} onChange={e => setName(e.target.value)} />
          </label>
          <label>
            Company PIN
            <input
              className="pin-input"
              required
              type="password"
              inputMode="numeric"
              autoComplete="off"
              pattern="[0-9]{6,12}"
              title="6 to 12 digits"
              maxLength={12}
              value={pin}
              onChange={e => setPin(e.target.value.replace(/\D/g, ''))}
            />
          </label>
          {msg && (
            <div className="notice error" role="alert">
              <Icon name="alert" /> <div>{msg}</div>
            </div>
          )}
          <button className="primary" disabled={busy} style={{ minHeight: 44 }}>
            {busy ? 'Checking…' : 'Enter'}
          </button>
          <div className="auth-foot muted small">
            Owner?{' '}
            <button type="button" className="link" onClick={() => (setMode('owner'), setMsg(null))}>
              Owner sign-in
            </button>
          </div>
        </form>
      ) : (
        <form className="card narrow" onSubmit={ownerSignIn}>
          <BrandMark />
          <div>
            <h1>Owner sign-in</h1>
            <p className="muted" style={{ marginTop: 6 }}>
              Manage the company, the PIN and devices.
            </p>
          </div>
          <label>
            Email
            <input type="email" required autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} />
          </label>
          <label>
            Password
            <input
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={e => setPassword(e.target.value)}
            />
          </label>
          {msg && (
            <div className="notice error" role="alert">
              <Icon name="alert" /> <div>{msg}</div>
            </div>
          )}
          <button className="primary" disabled={busy} style={{ minHeight: 44 }}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
          <div className="auth-foot">
            <button type="button" className="link" onClick={() => (setMode('pin'), setMsg(null))}>
              ← Back to PIN sign-in
            </button>
          </div>
        </form>
      )}
    </div>
  )
}
