import { useState } from 'react'
import Icon from './ui/Icon.jsx'

// Fallback/manual entry. A scanner typing into this field also works:
// its trailing Enter submits the form.
export function ScanInput({ onScan, placeholder = 'Type or scan a code' }) {
  const [value, setValue] = useState('')
  return (
    <form
      className="scan-input"
      onSubmit={e => {
        e.preventDefault()
        const v = value.trim()
        if (v) onScan(v.toUpperCase())
        setValue('')
      }}
    >
      <input value={value} onChange={e => setValue(e.target.value)} placeholder={placeholder} />
      <button className="secondary">Enter</button>
    </form>
  )
}

const FLASH_ICONS = {
  idle: <path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" />,
  ok: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  warn: (
    <>
      <path d="M12 4l9 16H3z" />
      <path d="M12 10v4M12 17.2v.1" />
    </>
  ),
  error: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9 9l6 6M15 9l-6 6" />
    </>
  ),
}
const FLASH_LABELS = { idle: 'Ready', ok: 'Done', warn: 'Check this unit', error: 'Problem' }

function FlashLabel({ kind }) {
  // Icon + word, so the state is never carried by colour alone.
  return (
    <div className="flash-label">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {FLASH_ICONS[kind]}
      </svg>
      <span>{FLASH_LABELS[kind]}</span>
    </div>
  )
}

// Big status panel for the last scan — readable from a distance.
export function ScanFlash({ entry, idle }) {
  if (!entry) {
    return (
      <div className="flash idle" role="status" aria-live="polite">
        <FlashLabel kind="idle" />
        <div className="flash-title">{idle}</div>
        <div className="flash-sub">Point the scanner at a label. No need to click anything.</div>
      </div>
    )
  }
  return (
    <div className={`flash ${entry.kind}`} key={entry.id} role="status" aria-live="polite">
      <FlashLabel kind={entry.kind} />
      <div className="flash-title">{entry.title}</div>
      <div className="flash-sub">
        <code>{entry.code}</code> {entry.detail}
      </div>
    </div>
  )
}

export function ScanFeed({ entries }) {
  if (!entries.length) return null
  return (
    <ul className="feed">
      {entries.map(e => (
        <li key={e.id} className={e.kind}>
          <span className="dot" />
          <code>{e.code}</code>
          <span className="feed-title">{e.title}</span>
          <span className="muted">{e.detail}</span>
          <span className="muted time">
            {e.clientId &&
              (e.synced ? (
                <span className="sync-mark ok" title="Confirmed by server">
                  <Icon name="check" size={13} /> synced
                </span>
              ) : (
                <span className="sync-mark" title="Saved on this device, waiting to sync">
                  <Icon name="clock" size={13} /> pending
                </span>
              ))}
            {e.time}
          </span>
        </li>
      ))}
    </ul>
  )
}

let seq = 0
export function makeEntry(kind, code, title, detail = '') {
  return {
    id: ++seq,
    kind,
    code,
    title,
    detail,
    time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
  }
}
