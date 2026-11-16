import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { useScanner } from '../lib/useScanner.js'
import { normalizeCode } from '../lib/scanDetector.js'
import { loadSettings } from '../lib/settings.js'
import Labels from './Labels.jsx'
import Icon from './ui/Icon.jsx'
import { PageHeader, Section, EmptyState, StatusBadge, useUI } from './ui/ui.jsx'

// One place for labels:
//   * New labels — pick a product and how many; codes follow its pattern.
//   * Reprint — scan or type existing codes (lost/damaged pieces keep their
//     code). Works offline: it reads the device's unit cache.
export default function LabelStudio({ engine, orgId, products, onBack, onCreated }) {
  const ui = useUI()
  const [queue, setQueue] = useState([]) // [{ code, product, status }]
  const [code, setCode] = useState('')
  const [productId, setProductId] = useState('')
  const [count, setCount] = useState(1)
  const [preview, setPreview] = useState([])
  const [busy, setBusy] = useState(false)
  const [printing, setPrinting] = useState(false)
  const [allFor, setAllFor] = useState('')

  const coded = (products ?? []).filter(p => p.category !== 'BLO')
  const selected = coded.find(p => p.id === productId) ?? coded[0]

  useEffect(() => {
    if (!selected?.code_stem) return setPreview([])
    supabase.rpc('next_codes', { p_product: selected.id, p_count: Math.min(Number(count) || 1, 3) }).then(({ data }) => setPreview(data ?? []))
  }, [selected?.id, selected?.code_stem, count])

  function addToQueue(items) {
    setQueue(q => {
      const have = new Set(q.map(x => x.code))
      return [...q, ...items.filter(x => !have.has(x.code))]
    })
  }

  async function addCode(raw) {
    const c = normalizeCode(raw)
    if (!c) return
    const units = await engine.listUnits(orgId)
    const u = units.find(x => x.code === c)
    if (!u) return ui.toast(`${c} isn’t a registered code. New pieces: use “New labels”.`, 'error')
    if (u.status === 'retired') return ui.toast(`${c} is retired (discarded). Restore it in Inventory first.`, 'error')
    addToQueue([{ code: u.code, product: u.product, status: u.status }])
    ui.toast(`${c} added to print.`, 'ok')
  }

  // A scanner works anywhere on this screen.
  useScanner(addCode, { ...loadSettings(), enabled: !printing })

  async function addAllOf(id) {
    const units = (await engine.listUnits(orgId)).filter(u => u.product_id === id && u.status !== 'retired')
    if (!units.length) return ui.toast('That product has no units yet.', 'error')
    addToQueue(units.sort((a, b) => a.code.localeCompare(b.code)).map(u => ({ code: u.code, product: u.product, status: u.status })))
    setAllFor('')
  }

  async function generate(e) {
    e.preventDefault()
    if (!selected) return
    setBusy(true)
    const { data, error } = await supabase.rpc('generate_units', { p_product: selected.id, p_count: Number(count) })
    setBusy(false)
    if (error) return ui.toast(!error.code ? 'Creating new labels needs a connection.' : error.message, 'error')
    addToQueue(data.map(u => ({ code: u.code, product: selected.name, status: u.status })))
    ui.toast(`${data.length} new code${data.length === 1 ? '' : 's'} created: ${data[0].code}${data.length > 1 ? ` … ${data[data.length - 1].code}` : ''}.`, 'ok')
    engine.pullUnits(orgId).catch(() => {})
    onCreated?.()
  }

  if (printing) {
    return <Labels units={queue} onClose={() => setPrinting(false)} backLabel="Back to label list" />
  }

  return (
    <>
      <PageHeader
        back={{ label: 'Inventory', onClick: onBack }}
        title="Labels"
        description="Create labels for new pieces, or reprint a lost or damaged label with the same code."
        actions={
          <button className="primary" disabled={!queue.length} onClick={() => setPrinting(true)}>
            <Icon name="printer" /> Print {queue.length || ''} label{queue.length === 1 ? '' : 's'}
          </button>
        }
      />

      <div className="grid2">
        <Section title="New labels" description="New physical pieces get the next codes in their product’s pattern.">
          {coded.length === 0 ? (
            <p className="muted small">Create a product in Inventory first.</p>
          ) : (
            <form className="stack" style={{ gap: 14 }} onSubmit={generate}>
              <label>
                Product
                <select value={selected?.id ?? ''} onChange={e => setProductId(e.target.value)} data-testid="studio-product">
                  {coded.map(p => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                      {p.code_stem ? ` — ${p.code_stem}-…` : ''}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                How many pieces?
                <input type="number" min={1} max={500} value={count} onChange={e => setCount(e.target.value)} />
                <span className="hint">
                  {preview.length
                    ? `Next: ${preview.join(', ')}${Number(count) > preview.length ? ' …' : ''}`
                    : selected?.code_stem
                      ? ''
                      : 'This product uses random codes.'}
                </span>
              </label>
              <div className="row end">
                <button className="secondary" disabled={busy}>
                  <Icon name="plus" /> {busy ? 'Creating…' : 'Create and add to list'}
                </button>
              </div>
            </form>
          )}
        </Section>

        <Section title="Reprint" description="Same code, new label. Scan the old label or type its code.">
          <form
            className="scan-input"
            onSubmit={e => {
              e.preventDefault()
              addCode(code)
              setCode('')
            }}
          >
            <input
              placeholder="e.g. BAN-PAW45-01"
              value={code}
              onChange={e => setCode(e.target.value.toUpperCase())}
              aria-label="Code to reprint"
              data-testid="reprint-code"
            />
            <button className="secondary">Add</button>
          </form>
          <div className="row" style={{ marginTop: 14 }}>
            <select value={allFor} onChange={e => setAllFor(e.target.value)} aria-label="Product to reprint">
              <option value="">Or all pieces of a product…</option>
              {(products ?? []).map(p => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <button type="button" className="secondary" disabled={!allFor} onClick={() => addAllOf(allFor)}>
              Add
            </button>
          </div>
        </Section>
      </div>

      <Section
        flush
        title={`To print (${queue.length})`}
        actions={
          queue.length > 0 && (
            <button className="ghost btn-sm" onClick={() => setQueue([])}>
              Clear list
            </button>
          )
        }
      >
        {queue.length === 0 ? (
          <EmptyState icon="printer" title="Nothing to print yet">
            Create new labels or add codes to reprint. A lost or damaged piece keeps its code — just reprint it.
          </EmptyState>
        ) : (
          <ul className="list">
            {queue.map(q => (
              <li key={q.code}>
                <div className="li-main">
                  <span className="li-title mono">{q.code}</span>
                  <span className="li-sub">{q.product}</span>
                </div>
                <div className="li-end">
                  {q.status !== 'in_stock' && <StatusBadge status={q.status} />}
                  <button className="icon-btn" aria-label={`Remove ${q.code}`} onClick={() => setQueue(x => x.filter(y => y.code !== q.code))}>
                    <Icon name="x" size={16} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  )
}
