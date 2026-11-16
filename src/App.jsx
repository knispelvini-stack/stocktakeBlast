import { useCallback, useEffect, useState } from 'react'
import { supabase, configured } from './lib/supabase.js'
import { loadSettings, saveSettings } from './lib/settings.js'
import Auth from './components/Auth.jsx'
import CreateOrg from './components/CreateOrg.jsx'
import MoveScreen from './components/MoveScreen.jsx'
import CountScreen from './components/CountScreen.jsx'
import ProductsScreen from './components/ProductsScreen.jsx'
import SettingsScreen from './components/SettingsScreen.jsx'

const TABS = [
  { id: 'move', label: 'Check out / in' },
  { id: 'count', label: 'Stocktake' },
  { id: 'products', label: 'Products & labels' },
  { id: 'settings', label: 'Scanner' },
]

export default function App() {
  const [session, setSession] = useState(undefined) // undefined = loading
  const [memberships, setMemberships] = useState(null)
  const [orgId, setOrgId] = useState(null)
  const [tab, setTab] = useState('move')
  const [settings, setSettings] = useState(loadSettings)

  useEffect(() => {
    if (!configured) return
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => data.subscription.unsubscribe()
  }, [])

  const loadOrgs = useCallback(async () => {
    if (!session) return
    const { data, error } = await supabase
      .from('org_members')
      .select('org_id, role, orgs(name)')
      .eq('user_id', session.user.id)
      .order('created_at')
    if (error) {
      alert(error.message)
      return
    }
    setMemberships(data)
    setOrgId(cur => (data.some(m => m.org_id === cur) ? cur : data[0]?.org_id ?? null))
  }, [session])

  useEffect(() => {
    setMemberships(null)
    loadOrgs()
  }, [loadOrgs])

  function updateSettings(next) {
    setSettings(next)
    saveSettings(next)
  }

  if (!configured) {
    return (
      <div className="center-page">
        <div className="card narrow">
          <h1>Missing configuration</h1>
          <p className="muted">
            Copy <code>.env.example</code> to <code>.env</code> and fill in your Supabase URL and anon key.
          </p>
        </div>
      </div>
    )
  }
  if (session === undefined || (session && memberships === null)) {
    return <div className="center-page muted">Loading…</div>
  }
  if (!session) return <Auth />
  if (!orgId) return <CreateOrg onCreated={loadOrgs} />

  const current = memberships.find(m => m.org_id === orgId)

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          stocktake<span>Blast</span>
        </div>
        {memberships.length > 1 ? (
          <select value={orgId} onChange={e => setOrgId(e.target.value)}>
            {memberships.map(m => (
              <option key={m.org_id} value={m.org_id}>
                {m.orgs?.name}
              </option>
            ))}
          </select>
        ) : (
          <div className="org">{current?.orgs?.name}</div>
        )}
        <button className="ghost" onClick={() => supabase.auth.signOut()}>
          Sign out
        </button>
      </header>
      <nav className="tabs">
        {TABS.map(t => (
          <button
            key={t.id}
            className={tab === t.id ? 'active' : ''}
            onClick={e => {
              setTab(t.id)
              e.currentTarget.blur() // keep Enter from the scanner off this button
            }}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <main className="content">
        {tab === 'move' && <MoveScreen orgId={orgId} settings={settings} />}
        {tab === 'count' && <CountScreen orgId={orgId} settings={settings} />}
        {tab === 'products' && <ProductsScreen orgId={orgId} />}
        {tab === 'settings' && <SettingsScreen settings={settings} onChange={updateSettings} />}
      </main>
    </div>
  )
}
