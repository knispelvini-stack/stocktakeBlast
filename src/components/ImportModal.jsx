import { useState } from 'react'
import { supabase } from '../lib/supabase.js'
import Icon from './ui/Icon.jsx'
import { Modal, useUI } from './ui/ui.jsx'
import { parseCsv, rowsToProducts, IMPORT_COLUMNS, IMPORT_TEMPLATE } from '../lib/csv.js'

// Owner-only bulk import. The database checks everything again
// (import_products, all-or-nothing); this preview just catches the obvious.
export default function ImportModal({ orgId, onClose, onImported }) {
  const ui = useUI()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const parsed = text.trim() ? rowsToProducts(parseCsv(text)) : null

  async function readFile(e) {
    const f = e.target.files?.[0]
    if (f) setText(await f.text())
  }

  function template() {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([IMPORT_TEMPLATE], { type: 'text/csv;charset=utf-8' }))
    a.download = 'inventory-import-template.csv'
    a.click()
    URL.revokeObjectURL(a.href)
  }

  async function submit() {
    setBusy(true)
    const { data, error } = await supabase.rpc('import_products', { p_org: orgId, p_rows: parsed.rows })
    setBusy(false)
    if (error) return ui.toast(error.code ? `Nothing was imported. ${error.message}` : 'Needs a connection.', 'error')
    const units = data.reduce((n, r) => n + r.units, 0)
    ui.toast(`Imported ${data.length} product${data.length === 1 ? '' : 's'} and ${units} label${units === 1 ? '' : 's'}.`, 'ok')
    onImported()
  }

  const errors = parsed?.errors ?? []
  return (
    <Modal
      title="Import products from CSV"
      description="One row per product. Labels are numbered by the database, exactly as when you create them by hand. All rows are imported, or none."
      onClose={onClose}
      size="lg"
      footer={
        <>
          <button className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={!parsed?.rows.length || errors.length > 0 || busy} onClick={submit} data-testid="import-submit">
            {busy ? 'Importing…' : parsed?.rows.length ? `Import ${parsed.rows.length} product${parsed.rows.length === 1 ? '' : 's'}` : 'Import'}
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <label className="secondary file-btn">
            <Icon name="download" /> Choose CSV file
            <input type="file" accept=".csv,text/csv" onChange={readFile} hidden />
          </label>
          <button className="ghost" type="button" onClick={template}>
            Download template
          </button>
        </div>
        <label>
          …or paste it here
          <textarea
            rows={6}
            className="mono"
            value={text}
            onChange={e => setText(e.target.value)}
            placeholder={IMPORT_TEMPLATE}
            data-testid="import-text"
          />
        </label>
        <p className="hint">
          Columns: {IMPORT_COLUMNS.map(c => <code key={c}>{c}</code>).reduce((a, b) => [a, ', ', b])}. <b>type</b> is BAN
          (banner: theme + size, and prefix for a new theme), CAS, BLO (codes by hand, quantity 0) or OTHER (optional
          stem). <b>quantity</b> = labels to create.
        </p>
        {errors.length > 0 && (
          <div className="notice warn">
            <Icon name="alert" />
            <div>
              {errors.slice(0, 5).map(e => (
                <div key={e}>{e}</div>
              ))}
              {errors.length > 5 && <div>…and {errors.length - 5} more</div>}
            </div>
          </div>
        )}
        {parsed?.rows.length > 0 && (
          <div className="table-wrap">
            <table className="table" data-testid="import-preview">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Type</th>
                  <th>Name / theme</th>
                  <th className="hide-sm">Size / stem</th>
                  <th className="num">Labels</th>
                </tr>
              </thead>
              <tbody>
                {parsed.rows.slice(0, 50).map((r, i) => (
                  <tr key={i}>
                    <td className="muted">{i + 1}</td>
                    <td>{r.type}</td>
                    <td>{r.name || `${r.theme} banner ${r.size ?? ''}`}</td>
                    <td className="hide-sm mono">{r.type === 'BAN' ? r.size : r.stem}</td>
                    <td className="num">{r.quantity || 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {parsed.rows.length > 50 && <p className="muted small">+{parsed.rows.length - 50} more rows</p>}
          </div>
        )}
      </div>
    </Modal>
  )
}
