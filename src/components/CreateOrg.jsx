import { useState } from 'react'
import { supabase } from '../lib/supabase.js'

export default function CreateOrg({ onCreated }) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function submit(e) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const { error } = await supabase.rpc('create_org', { p_name: name })
    setBusy(false)
    if (error) setError(error.message)
    else onCreated()
  }

  return (
    <div className="center-page">
      <form className="card narrow" onSubmit={submit}>
        <h1>Create your company</h1>
        <p className="muted">Everything you scan is kept inside this company.</p>
        <label>
          Company name
          <input required value={name} onChange={e => setName(e.target.value)} autoFocus />
        </label>
        {error && <div className="notice error">{error}</div>}
        <button className="primary" disabled={busy}>
          {busy ? '…' : 'Create'}
        </button>
        <button type="button" className="link" onClick={() => supabase.auth.signOut()}>
          Sign out
        </button>
      </form>
    </div>
  )
}
