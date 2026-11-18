import { useState } from 'react'
import { useScanner } from '../lib/useScanner.js'
import { beep } from '../lib/beep.js'
import Icon from './ui/Icon.jsx'
import { PageHeader, Section, Badge } from './ui/ui.jsx'
import { CompanySettings, AccessSettings, VehicleSettings } from './AdminScreen.jsx'

// Settings = everything that isn't daily work. Owner-only sections are hidden
// from staff (and enforced on the server).
export default function SettingsScreen({ engine, settings, onChange, isOwner, orgId, orgName, overdueDays, scanReturns, onRenamed, who, signOut }) {
  const sections = [
    ...(isOwner
      ? [
          { id: 'company', label: 'Company', icon: 'building' },
          { id: 'access', label: 'PIN & devices', icon: 'users' },
          { id: 'vehicles', label: 'Vehicles', icon: 'truck' },
        ]
      : []),
    { id: 'scanner', label: 'Scanner', icon: 'barcode' },
    { id: 'account', label: 'Account', icon: 'shield' },
  ]
  const [section, setSection] = useState(sections[0].id)

  return (
    <>
      <PageHeader title="Settings" description={isOwner ? 'Company, access, this device’s scanner and your account.' : 'This device’s scanner and your account.'} />
      <div className="settings-grid">
        <nav className="settings-nav" aria-label="Settings sections">
          {sections.map(s => (
            <button
              key={s.id}
              data-section={s.id}
              className={section === s.id ? 'active' : ''}
              aria-current={section === s.id ? 'page' : undefined}
              onClick={e => {
                setSection(s.id)
                e.currentTarget.blur()
              }}
            >
              <Icon name={s.icon} /> {s.label}
            </button>
          ))}
        </nav>
        <div className="stack">
          {section === 'company' && <CompanySettings orgId={orgId} orgName={orgName} overdueDays={overdueDays} scanReturns={scanReturns} onRenamed={onRenamed} />}
          {section === 'access' && <AccessSettings orgId={orgId} />}
          {section === 'vehicles' && <VehicleSettings engine={engine} orgId={orgId} />}
          {section === 'scanner' && <ScannerSettings settings={settings} onChange={onChange} />}
          {section === 'account' && <AccountSettings who={who} orgName={orgName} signOut={signOut} />}
        </div>
      </div>
    </>
  )
}

function AccountSettings({ who, orgName, signOut }) {
  return (
    <Section title="Account" description="Who this device is signed in as.">
      <dl className="kv">
        <dt>Signed in as</dt>
        <dd>{who.name}</dd>
        <dt>Role</dt>
        <dd>
          <Badge tone={who.role === 'Owner' ? 'accent' : 'neutral'}>{who.role}</Badge>
        </dd>
        <dt>Company</dt>
        <dd>{orgName}</dd>
      </dl>
      <div className="row end" style={{ marginTop: 18 }}>
        <button className="secondary" onClick={signOut}>
          <Icon name="logout" /> Sign out
        </button>
      </div>
    </Section>
  )
}

// Scanner setup + live test. Raw key timings help tune maxGapMs for slower
// Bluetooth scanners.
function ScannerSettings({ settings, onChange }) {
  const [scans, setScans] = useState([])
  const [gaps, setGaps] = useState([])

  useScanner(
    code => {
      setScans(s => [{ code, at: new Date().toLocaleTimeString() }, ...s].slice(0, 10))
      beep('ok', settings.sound)
    },
    settings,
  )

  // Measure the scanner's real inter-key gap from a test field.
  const [lastKey, setLastKey] = useState(null)
  function measure(e) {
    const now = performance.now()
    if (e.key === 'Enter') {
      setLastKey(null)
      e.currentTarget.value = ''
      return
    }
    if (lastKey !== null) setGaps(g => [...g, now - lastKey].slice(-40))
    setLastKey(now)
  }
  const avg = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null
  const max = gaps.length ? Math.max(...gaps) : null

  return (
    <>
      <Section title="1 · Set up the scanner" description="Any USB or Bluetooth scanner that works as a keyboard. No drivers.">
        <ol className="steps">
          <li>
            Put the scanner in <b>USB HID / keyboard</b> mode (Bluetooth: pair it as a keyboard, not SPP/serial).
          </li>
          <li>
            Set the suffix to <b>Enter</b> (CR). Most scanners ship like this.
          </li>
          <li>Match the scanner’s keyboard language to the computer’s (e.g. US). If they differ, codes come out garbled.</li>
          <li>Make sure Code 128 is enabled (it almost always is).</li>
        </ol>
      </Section>

      <Section title="2 · Test it" description="Click somewhere empty on the page (not in a field) and scan any barcode.">
        {scans.length === 0 ? (
          <div className="flash idle" style={{ minHeight: 140 }}>
            <div className="flash-title" style={{ fontSize: 20 }}>
              Waiting for a scan…
            </div>
          </div>
        ) : (
          <ul className="feed" style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
            {scans.map((s, i) => (
              <li key={i} className="ok">
                <span className="dot" />
                <code>{s.code}</code>
                <span className="muted time">{s.at}</span>
              </li>
            ))}
          </ul>
        )}
        <label style={{ marginTop: 16 }}>
          Nothing appears? Scan into this field instead
          <input placeholder="Scan into this field to measure speed" onKeyDown={measure} />
          <span className="hint">If text shows up here, the scanner works but is slower than the threshold below — raise it.</span>
        </label>
        {avg !== null && (
          <div className={`notice ${max > settings.maxGapMs ? 'warn' : 'ok'}`} style={{ marginTop: 12 }}>
            <Icon name={max > settings.maxGapMs ? 'alert' : 'check'} />
            <div>
              Average gap between keys <b>{avg.toFixed(0)} ms</b>, slowest <b>{max.toFixed(0)} ms</b>.{' '}
              {max > settings.maxGapMs
                ? `Above the ${settings.maxGapMs} ms threshold — set it to about ${Math.ceil((max + 15) / 10) * 10} ms.`
                : 'Within the threshold.'}
            </div>
          </div>
        )}
      </Section>

      <Section title="3 · Tune" description="Saved on this device only.">
        <label>
          <span className="row" style={{ justifyContent: 'space-between' }}>
            Max gap between keys <b className="mono">{settings.maxGapMs} ms</b>
          </span>
          <input
            type="range"
            min={20}
            max={150}
            step={5}
            value={settings.maxGapMs}
            onChange={e => onChange({ ...settings, maxGapMs: Number(e.target.value) })}
          />
          <span className="hint">Lower: fast typing is never mistaken for a scan. Higher: works with slow Bluetooth scanners.</span>
        </label>
        <label className="check" style={{ marginTop: 14 }}>
          <input type="checkbox" checked={settings.sound} onChange={e => onChange({ ...settings, sound: e.target.checked })} />
          <span>Beep on scan</span>
        </label>
      </Section>
    </>
  )
}
