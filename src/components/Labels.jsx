import { useEffect, useRef, useState } from 'react'
import JsBarcode from 'jsbarcode'
import QRCode from 'qrcode'
import Icon from './ui/Icon.jsx'
import { PageHeader } from './ui/ui.jsx'

// Printable labels. The code text is always printed large, so a person can
// read it; the symbol (Code 128 barcode or QR) is for the scanner.
const LAYOUTS = {
  a4: { name: 'A4 sheet — 3 × 8, 63.5 × 33.9 mm (Avery L7159)', page: 'A4', cls: 'sheet-a4' },
  thermal: { name: 'Thermal roll — 50 × 25 mm, one per label', page: '50mm 25mm', cls: 'sheet-thermal' },
}
const SYMBOLS = {
  barcode: 'Barcode (Code 128) — any scanner',
  qr: 'QR code — needs a 2D (imager) scanner',
}

function useStored(key, initial) {
  const [v, setV] = useState(() => {
    try {
      return localStorage.getItem(key) || initial
    } catch {
      return initial
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem(key, v)
    } catch {
      /* ignore */
    }
  }, [key, v])
  return [v, setV]
}

// For a label printer's own software (e.g. a P-touch / Zebra database import)
// or a print shop: one row per label, the code and the product.
function downloadCsv(units) {
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`
  const body = ['code,product', ...units.map(u => `${esc(u.code)},${esc(u.product)}`)].join('\r\n')
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob(['\uFEFF' + body], { type: 'text/csv;charset=utf-8' }))
  a.download = `labels-${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(a.href)
}

export default function Labels({ units, onClose, backLabel = 'Back' }) {
  const [layout, setLayout] = useStored('stb.labelLayout', 'a4')
  const [symbol, setSymbol] = useStored('stb.labelSymbol', 'barcode')
  const L = LAYOUTS[layout] ?? LAYOUTS.a4

  return (
    <div className="labels-screen">
      <style>{`@media print { @page { size: ${L.page}; margin: ${layout === 'a4' ? '12.9mm 7.25mm 0' : '0'}; } }`}</style>
      <div className="no-print stack">
        <PageHeader
          back={{ label: backLabel, onClick: onClose }}
          title="Print labels"
          description={`${units.length} label${units.length === 1 ? '' : 's'} · print at 100% scale (no “fit to page”) so scanners read them reliably.`}
          actions={
            <>
              <button className="secondary" onClick={() => downloadCsv(units)} disabled={!units.length} data-testid="labels-csv">
                <Icon name="download" /> Codes (CSV)
              </button>
              <button className="primary" onClick={() => window.print()} disabled={!units.length}>
                <Icon name="printer" /> Print {units.length} label{units.length === 1 ? '' : 's'}
              </button>
            </>
          }
        />
        <div className="form-row" style={{ maxWidth: 760 }}>
          <label>
            Label stock
            <select value={layout} onChange={e => setLayout(e.target.value)}>
              {Object.entries(LAYOUTS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Symbol
            <select value={symbol} onChange={e => setSymbol(e.target.value)} data-testid="label-symbol">
              {Object.entries(SYMBOLS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
        </div>
        {symbol === 'barcode' && units.some(u => u.code.length > (layout === 'thermal' ? 10 : 13)) && (
          <div className="notice warn" style={{ maxWidth: 760 }}>
            <Icon name="alert" />
            <div>
              Some codes are long for this label size, so the bars get thin and basic scanners may struggle. Test one label
              first, use the A4 sheet, or switch to QR if your scanner reads it.
            </div>
          </div>
        )}
        {symbol === 'qr' && (
          <div className="notice warn" style={{ maxWidth: 760 }}>
            <Icon name="alert" />
            <div>
              Most laser and basic scanners only read barcodes. Test one QR label with your scanner (Settings → Scanner)
              before printing a batch.
            </div>
          </div>
        )}
      </div>
      <div className={`print-area ${L.cls}`}>
        {units.map(u => (
          <Label key={u.code} code={u.code} product={u.product} symbol={symbol} />
        ))}
      </div>
    </div>
  )
}

function Label({ code, product, symbol }) {
  const ref = useRef(null)
  const [qr, setQr] = useState('')

  useEffect(() => {
    if (symbol !== 'barcode' || !ref.current) return
    JsBarcode(ref.current, code, {
      format: 'CODE128',
      displayValue: false, // printed below, larger, by us
      height: 48,
      margin: 0,
      marginLeft: 20, // Code 128 needs a quiet zone either side
      marginRight: 20,
      width: 2,
    })
  }, [code, symbol])

  useEffect(() => {
    if (symbol !== 'qr') return
    let alive = true
    QRCode.toString(code, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' }).then(s => alive && setQr(s))
    return () => {
      alive = false
    }
  }, [code, symbol])

  if (symbol === 'qr') {
    return (
      <div className="label label-qr">
        <div className="label-qr-img" dangerouslySetInnerHTML={{ __html: qr }} />
        <div className="label-qr-text">
          <div className="label-code">{code}</div>
          <div className="label-product">{product}</div>
        </div>
      </div>
    )
  }
  return (
    <div className="label">
      <div className="label-product">{product}</div>
      <svg ref={ref} />
      <div className="label-code">{code}</div>
    </div>
  )
}
