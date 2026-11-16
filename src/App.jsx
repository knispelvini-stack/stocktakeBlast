import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { supabase, configured } from './lib/supabase.js'
import { loadSettings, saveSettings } from './lib/settings.js'
import { openLocalDb } from './lib/localdb.js'
import { createSyncEngine } from './lib/sync.js'
import Auth from './components/Auth.jsx'
import AdminScreen from './components/AdminScreen.jsx'
import MoveScreen from './components/MoveScreen.jsx'
import CountScreen from './components/CountScreen.jsx'
import ProductsScreen from './components/ProductsScreen.jsx'
import HistoryScreen from './components/HistoryScreen.jsx'
import SettingsScreen from './components/SettingsScreen.jsx'
import SyncBadge from './components/SyncBadge.jsx'

const TABS = [
  { id: 'move', label: 'Check out / in' },
  { id: 'count', label: 'Stocktake' },
  { id: 'history', label: 'History' },
  { id: 'products', label: 'Products & labels' },
  { id: 'settings', label: 'Scanner' },
  { id: 'admin', label: 'Admin', ownerOnly: true },
]

const dbPromise = configured ? openLocalDb() : null

async function rpc(name, args) {
  const { data, error, status } = await supabase.rpc(name, args)
  return { data, error, status }
}

export default function App() {
  const [session, setSession] = useState(undefined) // undefined = loading
  const [engine, setEngine] = useState(null)
  const [orgs, setOrgs] = useState(null)
  const [orgsError, setOrgsError] = useState(null)
  const [orgId, setOrgId] = useState(null)
  const [tab, setTab] = useState('move')
  const [historyCode, setHistoryCode] = useState('')
  const [settings, setSettings] = useState(loadSettings)
  const [pinBusy, setPinBusy] = useState(false) // keep the PIN screen mounted while joining

  // auth
  useEffect(() => {
    if (!configured) return
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => data.subscription.unsubscribe()
  }, [])

  // local DB + sync engine (one per page)
  useEffect(() => {
    if (!configured) return
    let stop
    dbPromise.then(db => {
      const e = createSyncEngine({
        db,
        rpc,
        refreshAuth: async () => !(await supabase.auth.refreshSession()).error,
      })
      stop = e.start()
      setEngine(e)
    })
    return () => stop?.()
  }, [])

  const userId = session?.user?.id ?? null
  const isAnon = !!session?.user?.is_anonymous

  // Reads the user from the auth client, not from render state: the PIN
  // screen calls this right after signInAnonymously(), before React has
  // re-rendered with the new session (a stale userId made it a no-op).
  const loadOrgs = useCallback(async () => {
    if (!engine) return
    const { data } = await supabase.auth.getSession()
    const uid = data.session?.user?.id
    if (!uid) return
    setOrgsError(null)
    try {
      const list = await engine.loadOrgs(uid)
      setOrgs(list)
      setOrgId(cur => (list.some(o => o.org_id === cur) ? cur : list[0]?.org_id ?? null))
    } catch (e) {
      setOrgsError(e.message)
    }
  }, [engine])

  useEffect(() => {
    setOrgs(null)
    loadOrgs()
  }, [loadOrgs, userId])

  const current = orgs?.find(o => o.org_id === orgId)
  // Name shown in history for this device's own (not yet synced) scans.
  const userLabel = isAnon ? current?.display_name ?? null : session?.user?.email ?? null
  useEffect(() => {
    engine?.setUser(userId, userLabel)
  }, [engine, userId, userLabel])

  // keep the offline cache fresh for the current org
  useEffect(() => {
    if (!engine || !orgId) return
    const refresh = () => {
      engine.refreshOrg(orgId)
      supabase.rpc('touch_device', { p_org: orgId }).then(() => {}) // "last active" in Admin
    }
    refresh()
    const t = setInterval(refresh, 5 * 60_000)
    const onOnline = refresh
    window.addEventListener('online', onOnline)
    return () => {
      clearInterval(t)
      window.removeEventListener('online', onOnline)
    }
  }, [engine, orgId])

  function updateSettings(next) {
    setSettings(next)
    saveSettings(next)
  }

  async function signOut() {
    const pending = engine?.getState().pending ?? 0
    if (
      pending &&
      !confirm(
        `${pending} scan${pending === 1 ? ' has' : 's have'} not been sent to the server yet.\n\n` +
          'Signing out now DELETES them from this device. Connect to the internet and wait for “Synced” instead.\n\n' +
          'Sign out anyway?',
      )
    )
      return
    if (!pending && isAnon && !confirm('Sign out this device? You will need the company PIN to get back in.')) return
    await engine?.clearAll() // shared devices: don't leave company data behind
    await supabase.auth.signOut({ scope: 'local' })
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
  if (session === undefined || !engine) return <div className="center-page muted">Loading…</div>
  // PIN screen: no session yet, an anonymous device that hasn't joined, or mid-join.
  if (pinBusy || !session || (isAnon && orgs?.length === 0)) {
    return <Auth key="auth" onBusy={setPinBusy} onJoined={loadOrgs} />
  }
  if (orgsError) {
    return (
      <div className="center-page">
        <div className="card narrow">
          <h1>Can’t load your company</h1>
          <p className="muted">{orgsError}</p>
          <button className="primary" onClick={loadOrgs}>
            Try again
          </button>
          <button className="link" onClick={signOut}>
            Sign out
          </button>
        </div>
      </div>
    )
  }
  if (orgs === null) return <div className="center-page muted">Loading…</div>
  if (!orgId) {
    // An email account that isn't part of the company.
    return (
      <div className="center-page">
        <div className="card narrow">
          <h1>No access</h1>
          <p className="muted">
            {session.user.email} is not part of this company. Staff sign in with the company PIN.
          </p>
          <button className="primary" onClick={signOut}>
            Sign out and use the PIN
          </button>
        </div>
      </div>
    )
  }
  const isOwner = current?.role === 'owner' && !isAnon

  return (
    <Shell
      engine={engine}
      orgs={orgs}
      orgId={orgId}
      setOrgId={setOrgId}
      tab={tab}
      setTab={setTab}
      signOut={signOut}
      isOwner={isOwner}
    >
      {tab === 'move' && <MoveScreen engine={engine} orgId={orgId} settings={settings} />}
      {tab === 'count' && <CountScreen engine={engine} orgId={orgId} settings={settings} />}
      {tab === 'history' && (
        <HistoryScreen engine={engine} orgId={orgId} settings={settings} initialCode={historyCode} />
      )}
      {tab === 'products' && (
        <ProductsScreen
          engine={engine}
          orgId={orgId}
          onShowHistory={code => {
            setHistoryCode(code)
            setTab('history')
          }}
        />
      )}
      {tab === 'settings' && <SettingsScreen settings={settings} onChange={updateSettings} />}
      {tab === 'admin' && isOwner && <AdminScreen orgId={orgId} orgName={current?.name ?? ''} onRenamed={loadOrgs} />}
    </Shell>
  )
}

function Shell({ engine, orgs, orgId, setOrgId, tab, setTab, signOut, isOwner, children }) {
  const sync = useSyncExternalStore(engine.subscribe, engine.getState)
  const current = useMemo(() => orgs.find(o => o.org_id === orgId), [orgs, orgId])
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          stocktake<span>Blast</span>
        </div>
        {orgs.length > 1 ? (
          <select value={orgId} onChange={e => setOrgId(e.target.value)}>
            {orgs.map(o => (
              <option key={o.org_id} value={o.org_id}>
                {o.name}
              </option>
            ))}
          </select>
        ) : (
          <div className="org">{current?.name}</div>
        )}
        <SyncBadge sync={sync} onClick={() => setTab('history')} onRetry={() => engine.flush()} />
        <button className="ghost" onClick={signOut}>
          Sign out
        </button>
      </header>
      <nav className="tabs">
        {TABS.filter(t => !t.ownerOnly || isOwner).map(t => (
          <button
            key={t.id}
            className={tab === t.id ? 'active' : ''}
            onClick={e => {
              setTab(t.id)
              e.currentTarget.blur() // keep Enter from the scanner off this button
            }}
          >
            {t.label}
            {t.id === 'history' && sync.attention > 0 && <span className="badge">{sync.attention}</span>}
          </button>
        ))}
      </nav>
      <main className="content">{children}</main>
    </div>
  )
}
