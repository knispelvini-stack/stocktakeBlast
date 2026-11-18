import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { supabase, configured } from './lib/supabase.js'
import { loadSettings, saveSettings } from './lib/settings.js'
import { openLocalDb } from './lib/localdb.js'
import { createSyncEngine } from './lib/sync.js'
import Auth from './components/Auth.jsx'
import OverviewScreen from './components/OverviewScreen.jsx'
import MoveScreen from './components/MoveScreen.jsx'
import CountScreen from './components/CountScreen.jsx'
import ProductsScreen from './components/ProductsScreen.jsx'
import HistoryScreen from './components/HistoryScreen.jsx'
import SettingsScreen from './components/SettingsScreen.jsx'
import SyncBadge from './components/SyncBadge.jsx'
import Icon from './components/ui/Icon.jsx'
import { useUI } from './components/ui/ui.jsx'

// Information architecture: daily work first, records second, configuration
// out of the way (gear). Same five destinations on desktop and phone.
const NAV = [
  { id: 'overview', label: 'Overview', short: 'Home', icon: 'home', group: 'Operations' },
  { id: 'move', label: 'Check out / in', short: 'Scan', icon: 'scan', group: 'Operations' },
  { id: 'count', label: 'Stocktake', short: 'Count', icon: 'clipboard', group: 'Operations' },
  { id: 'inventory', label: 'Inventory', short: 'Items', icon: 'box', group: 'Records' },
  { id: 'activity', label: 'Activity', short: 'Activity', icon: 'activity', group: 'Records' },
]

const dbPromise = configured ? openLocalDb() : null

async function rpc(name, args) {
  const { data, error, status } = await supabase.rpc(name, args)
  return { data, error, status }
}

function CenterMessage({ title, children, actions }) {
  return (
    <div className="auth-page">
      <div className="card narrow">
        <Logo dark />
        <h1>{title}</h1>
        <div className="muted">{children}</div>
        {actions}
      </div>
    </div>
  )
}

export function Logo({ dark, subtitle }) {
  return (
    <div className={dark ? 'auth-brand' : 'sidebar-brand'}>
      <div className="logo-mark">
        <Icon name="barcode" size={18} strokeWidth={2.2} />
      </div>
      <div className="logo-text">
        stocktakeBlast
        {subtitle && <small>{subtitle}</small>}
      </div>
    </div>
  )
}

export default function App() {
  const ui = useUI()
  const [session, setSession] = useState(undefined) // undefined = loading
  const [engine, setEngine] = useState(null)
  const [orgs, setOrgs] = useState(null)
  const [orgsError, setOrgsError] = useState(null)
  const [orgId, setOrgId] = useState(null)
  const [tab, setTab] = useState(null) // null = default for this user
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
    setTab(null)
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
      supabase.rpc('touch_device', { p_org: orgId }).then(() => {}) // "last active" in Settings
    }
    refresh()
    const t = setInterval(refresh, 5 * 60_000)
    window.addEventListener('online', refresh)
    return () => {
      clearInterval(t)
      window.removeEventListener('online', refresh)
    }
  }, [engine, orgId])

  function updateSettings(next) {
    setSettings(next)
    saveSettings(next)
  }

  async function signOut() {
    const pending = engine?.getState().pending ?? 0
    if (pending) {
      const ok = await ui.confirm({
        title: 'Discard unsynced scans?',
        body: (
          <>
            <p>
              <strong>
                {pending} scan{pending === 1 ? ' has' : 's have'} not reached the server yet.
              </strong>
            </p>
            <p>Signing out deletes them from this device. Connect to the internet and wait for “Synced” instead.</p>
          </>
        ),
        confirmLabel: 'Sign out and discard',
        danger: true,
      })
      if (!ok) return
    } else if (isAnon) {
      const ok = await ui.confirm({
        title: 'Sign out this device?',
        body: 'You will need the company PIN to get back in.',
        confirmLabel: 'Sign out',
      })
      if (!ok) return
    }
    await engine?.clearAll() // shared devices: don't leave company data behind
    await supabase.auth.signOut({ scope: 'local' })
  }

  if (!configured) {
    return (
      <CenterMessage title="Missing configuration">
        Copy <code>.env.example</code> to <code>.env</code> and fill in your Supabase URL and anon key.
      </CenterMessage>
    )
  }
  if (session === undefined || !engine) return <div className="center-page muted">Loading…</div>
  // PIN screen: no session yet, an anonymous device that hasn't joined, or mid-join.
  if (pinBusy || !session || (isAnon && orgs?.length === 0)) {
    return <Auth key="auth" onBusy={setPinBusy} onJoined={loadOrgs} />
  }
  if (orgsError) {
    return (
      <CenterMessage
        title="Can’t load your company"
        actions={
          <div className="row">
            <button className="primary" onClick={loadOrgs}>
              Try again
            </button>
            <button className="ghost" onClick={signOut}>
              Sign out
            </button>
          </div>
        }
      >
        {orgsError}
      </CenterMessage>
    )
  }
  if (orgs === null) return <div className="center-page muted">Loading…</div>
  if (!orgId) {
    return (
      <CenterMessage
        title="No access"
        actions={
          <button className="primary" onClick={signOut}>
            Sign out and use the PIN
          </button>
        }
      >
        {session.user.email} is not part of this company. Staff sign in with the company PIN.
      </CenterMessage>
    )
  }

  const isOwner = current?.role === 'owner' && !isAnon
  // Staff open straight into scanning; the owner lands on the overview.
  const active = tab ?? (isOwner ? 'overview' : 'move')
  const go = id => setTab(id)
  const showHistory = code => {
    setHistoryCode(code)
    setTab('activity')
  }
  const who = {
    name: isAnon ? current?.display_name || 'This device' : session.user.email,
    role: isOwner ? 'Owner' : 'Staff device',
  }

  return (
    <Shell engine={engine} orgName={current?.name} active={active} go={go} signOut={signOut} who={who}>
      {active === 'overview' && <OverviewScreen engine={engine} orgId={orgId} go={go} onShowHistory={showHistory} overdueDays={current?.overdue_days ?? 3} scanReturns={current?.scan_returns ?? true} />}
      {active === 'move' && <MoveScreen engine={engine} orgId={orgId} settings={settings} scanReturns={current?.scan_returns ?? true} />}
      {active === 'count' && <CountScreen engine={engine} orgId={orgId} settings={settings} scanReturns={current?.scan_returns ?? true} />}
      {active === 'activity' && (
        <HistoryScreen engine={engine} orgId={orgId} settings={settings} initialCode={historyCode} />
      )}
      {active === 'inventory' && <ProductsScreen engine={engine} orgId={orgId} onShowHistory={showHistory} settings={settings} isOwner={isOwner} />}
      {active === 'settings' && (
        <SettingsScreen
          engine={engine}
          settings={settings}
          onChange={updateSettings}
          isOwner={isOwner}
          orgId={orgId}
          orgName={current?.name ?? ''}
          overdueDays={current?.overdue_days ?? 3}
          scanReturns={current?.scan_returns ?? true}
          onRenamed={loadOrgs}
          who={who}
          signOut={signOut}
        />
      )}
    </Shell>
  )
}

function Shell({ engine, orgName, active, go, signOut, who, children }) {
  const sync = useSyncExternalStore(engine.subscribe, engine.getState)
  const initials = useMemo(
    () =>
      (who.name || '?')
        .replace(/@.*/, '')
        .split(/[\s._-]+/)
        .filter(Boolean)
        .slice(0, 2)
        .map(s => s[0].toUpperCase())
        .join('') || '?',
    [who.name],
  )

  // Blur after navigating so a scanner's trailing Enter can't re-click it.
  const nav = (id, e) => {
    go(id)
    e.currentTarget.blur()
    window.scrollTo(0, 0)
  }
  const badgeFor = id => (id === 'activity' && sync.attention > 0 ? <span className="count">{sync.attention}</span> : null)

  return (
    <div className="shell">
      <aside className="sidebar">
        <Logo subtitle={orgName} />
        {['Operations', 'Records'].map(group => (
          <div className="nav-group" key={group}>
            <div className="nav-label">{group}</div>
            {NAV.filter(n => n.group === group).map(n => (
              <button
                key={n.id}
                data-nav={n.id}
                className={`nav-item ${active === n.id ? 'active' : ''}`}
                aria-current={active === n.id ? 'page' : undefined}
                onClick={e => nav(n.id, e)}
              >
                <Icon name={n.icon} />
                {n.label}
                {badgeFor(n.id)}
              </button>
            ))}
          </div>
        ))}
        <div className="sidebar-foot">
          <button
            data-nav="settings"
            className={`nav-item ${active === 'settings' ? 'active' : ''}`}
            onClick={e => nav('settings', e)}
          >
            <Icon name="settings" />
            Settings
          </button>
          <SyncBadge sync={sync} onClick={() => go('activity')} onRetry={() => engine.flush()} />
          <div className="who">
            <div className="avatar">{initials}</div>
            <div className="who-text">
              <div className="who-name" title={who.name}>
                {who.name}
              </div>
              <div className="who-role">{who.role}</div>
            </div>
            <button className="icon-btn" onClick={signOut} aria-label="Sign out" title="Sign out">
              <Icon name="logout" />
            </button>
          </div>
        </div>
      </aside>

      <div className="main">
        <header className="mobile-top">
          <div className="logo-mark">
            <Icon name="barcode" size={16} strokeWidth={2.2} />
          </div>
          <div className="logo-text">{orgName}</div>
          <SyncBadge sync={sync} compact onClick={() => go('activity')} onRetry={() => engine.flush()} />
          <button
            data-nav-mobile="settings"
            className={`icon-btn ${active === 'settings' ? 'active' : ''}`}
            onClick={e => nav('settings', e)}
            aria-label="Settings"
          >
            <Icon name="settings" size={20} />
          </button>
        </header>

        <main className="content">{children}</main>
      </div>

      <nav className="bottom-nav" aria-label="Main">
        {NAV.map(n => (
          <button
            key={n.id}
            data-nav-mobile={n.id}
            className={active === n.id ? 'active' : ''}
            aria-current={active === n.id ? 'page' : undefined}
            onClick={e => nav(n.id, e)}
          >
            <Icon name={n.icon} size={21} />
            {n.short}
            {badgeFor(n.id)}
          </button>
        ))}
      </nav>
    </div>
  )
}
