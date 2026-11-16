import { useState } from 'react'
import { useScanner } from '../lib/useScanner.js'
import { beep } from '../lib/beep.js'

// Scanner setup + live test. Raw key timings help tune maxGapMs for slower
// Bluetooth scanners.
export default function SettingsScreen({ settings, onChange }) {
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
    <div className="stack">
      <div className="card">
        <h2>1 · Set up the scanner</h2>
        <ol className="steps">
          <li>
            Put the scanner in <b>USB HID / keyboard</b> mode (for Bluetooth: pair it as a keyboard, not SPP/serial).
          </li>
          <li>
            Set the suffix to <b>Enter</b> (CR). Most scanners ship like this.
          </li>
          <li>
            Set the scanner’s keyboard language to match the computer’s (e.g. US or Portuguese). If they differ, codes come
            out garbled.
          </li>
          <li>Make sure Code 128 is enabled (it almost always is).</li>
        </ol>
      </div>

      <div className="card">
        <h2>2 · Test it</h2>
        <p className="muted">Click somewhere empty on the page (not in a field) and scan any barcode.</p>
        {scans.length === 0 ? (
          <div className="flash idle">
            <div className="flash-title">Waiting for a scan…</div>
          </div>
        ) : (
          <ul className="feed">
            {scans.map((s, i) => (
              <li key={i} className="ok">
                <span className="dot" />
                <code>{s.code}</code>
                <span className="muted time">{s.at}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="muted small">
          Nothing appears? Scan into the field below. If text shows up there, the scanner works but is slower than the
          current threshold — raise it.
        </p>
        <input placeholder="Scan into this field to measure speed" onKeyDown={measure} />
        {avg !== null && (
          <p className="small">
            Average gap between keys: <b>{avg.toFixed(0)} ms</b>, slowest <b>{max.toFixed(0)} ms</b>.{' '}
            {max > settings.maxGapMs ? (
              <span className="error-text">
                Above the {settings.maxGapMs} ms threshold — set it to about {Math.ceil((max + 15) / 10) * 10} ms.
              </span>
            ) : (
              <span className="ok-text">Within the threshold. ✓</span>
            )}
          </p>
        )}
      </div>

      <div className="card">
        <h2>3 · Tune</h2>
        <label>
          Max gap between keys: <b>{settings.maxGapMs} ms</b>
          <input
            type="range"
            min={20}
            max={150}
            step={5}
            value={settings.maxGapMs}
            onChange={e => onChange({ ...settings, maxGapMs: Number(e.target.value) })}
          />
        </label>
        <p className="muted small">
          Lower = harder for fast human typing to be mistaken for a scan. Higher = works with slow Bluetooth scanners.
        </p>
        <label className="check">
          <input type="checkbox" checked={settings.sound} onChange={e => onChange({ ...settings, sound: e.target.checked })} />
          <span>Beep on scan</span>
        </label>
        <p className="muted small">These settings are saved on this device only.</p>
      </div>
    </div>
  )
}
