import { useEffect, useRef, useState } from 'react'
import JsBarcode from 'jsbarcode'

// Printable barcode labels (Code 128).
const LAYOUTS = {
  a4: { name: 'A4 sheet — 3 × 8, 63.5 × 33.9 mm (Avery L7159)', page: 'A4', cls: 'sheet-a4' },
  thermal: { name: 'Thermal roll — 50 × 25 mm, one per label', page: '50mm 25mm', cls: 'sheet-thermal' },
}

export default function Labels({ units, onClose }) {
  const [layout, setLayout] = useState(() => {
    try {
      return localStorage.getItem('stb.labelLayout') || 'a4'
    } catch {
      return 'a4'
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem('stb.labelLayout', layout)
    } catch {
      /* ignore */
    }
  }, [layout])

  const L = LAYOUTS[layout]

  return (
    <div className="labels-screen">
      <style>{`@media print { @page { size: ${L.page}; margin: ${layout === 'a4' ? '12.9mm 7.25mm 0' : '0'}; } }`}</style>
      <div className="row wrap no-print">
        <button className="ghost" onClick={onClose}>
          ← Back
        </button>
        <select value={layout} onChange={e => setLayout(e.target.value)}>
          {Object.entries(LAYOUTS).map(([k, v]) => (
            <option key={k} value={k}>
              {v.name}
            </option>
          ))}
        </select>
        <button className="primary" onClick={() => window.print()}>
          Print {units.length} label{units.length === 1 ? '' : 's'}
        </button>
        <span className="muted small">Print at 100% scale (no “fit to page”) so scanners read the bars reliably.</span>
      </div>
      <div className={`print-area ${L.cls}`}>
        {units.map(u => (
          <Label key={u.code} code={u.code} product={u.product} />
        ))}
      </div>
    </div>
  )
}

function Label({ code, product }) {
  const ref = useRef(null)
  useEffect(() => {
    JsBarcode(ref.current, code, {
      format: 'CODE128',
      displayValue: true,
      fontSize: 14,
      height: 56,
      margin: 0,
      marginBottom: 6, // room for the text descenders
      textMargin: 2,
      marginLeft: 20, // Code 128 needs a quiet zone either side
      marginRight: 20,
      width: 2,
      font: 'monospace',
    })
  }, [code])
  return (
    <div className="label">
      <div className="label-product">{product}</div>
      <svg ref={ref} />
    </div>
  )
}
