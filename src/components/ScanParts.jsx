import { useState } from 'react'

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

// Big status panel for the last scan — readable from a distance.
export function ScanFlash({ entry, idle }) {
  if (!entry) {
    return (
      <div className="flash idle">
        <div className="flash-title">{idle}</div>
        <div className="flash-sub">Point the scanner at a label. No need to click anything.</div>
      </div>
    )
  }
  return (
    <div className={`flash ${entry.kind}`} key={entry.id}>
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
          <span className="muted time">{e.time}</span>
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
