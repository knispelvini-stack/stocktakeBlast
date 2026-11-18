import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import Labels from './Labels.jsx'
import LabelStudio from './LabelStudio.jsx'
import NewProductModal from './NewProductModal.jsx'
import Icon from './ui/Icon.jsx'
import { PageHeader, Section, EmptyState, Modal, StatusBadge, Stat, Badge, useUI, timeAgo } from './ui/ui.jsx'
import { useScanner } from '../lib/useScanner.js'
import { ConditionBadge, UnitModal } from './UnitActions.jsx'
import ImportModal from './ImportModal.jsx'

export default function ProductsScreen({ engine, orgId, onShowHistory, settings = {}, isOwner = false }) {
  const ui = useUI()
  const [highlight, setHighlight] = useState(null) // unit code to point at in the product
  const [importing, setImporting] = useState(false)
  const [localUnits, setLocalUnits] = useState([])
  const [products, setProducts] = useState(null)
  const [offline, setOffline] = useState(false)
  const [selected, setSelected] = useState(null)
  const [creating, setCreating] = useState(false)
  const [studio, setStudio] = useState(false)
  const [query, setQuery] = useState('')

  const load = useCallback(async () => {
    const [{ data: prods, error }, { data: stock }] = await Promise.all([
      supabase.from('products').select('id, name, sku, category, code_stem, code_digits, theme_id, size').eq('org_id', orgId).order('name'),
      supabase.from('product_stock').select('*').eq('org_id', orgId),
    ])
    if (error) {
      if (!error.code) return setOffline(true)
      return ui.toast(error.message, 'error')
    }
    setOffline(false)
    const byId = Object.fromEntries((stock ?? []).map(s => [s.product_id, s]))
    setProducts(prods.map(p => ({ ...p, stock: byId[p.id] ?? { in_stock: 0, out: 0, lost: 0, total: 0 } })))
  }, [orgId, ui])

  useEffect(() => {
    load()
  }, [load])

  // Unit codes come from the device cache: search and scan work offline.
  useEffect(() => {
    engine.listUnits(orgId).then(setLocalUnits)
  }, [engine, orgId, selected])

  function openUnit(code) {
    const u = localUnits.find(x => x.code === code)
    if (!u) return ui.toast(`${code} is not in your inventory (or this device hasn’t synced it yet).`, 'error')
    setQuery('')
    setHighlight(u.code)
    setSelected(u.product_id)
  }
  // Scanning a label on the product list opens that unit.
  useScanner(openUnit, { ...settings, enabled: !selected && !studio && !creating && !importing })

  if (studio)
    return (
      <LabelStudio
        engine={engine}
        orgId={orgId}
        products={products}
        onBack={() => {
          setStudio(false)
          load()
        }}
        onCreated={load}
      />
    )

  const product = products?.find(p => p.id === selected)
  if (product)
    return (
      <ProductDetail
        engine={engine}
        orgId={orgId}
        product={product}
        highlight={highlight}
        onChanged={load}
        onShowHistory={onShowHistory}
        onBack={() => {
          setSelected(null)
          setHighlight(null)
          load()
        }}
      />
    )

  const newButton = (
    <button className="primary" onClick={() => setCreating(true)} disabled={offline}>
      <Icon name="plus" /> New product
    </button>
  )

  const totals = (products ?? []).reduce(
    (t, p) => ({
      units: t.units + Number(p.stock.total),
      in_stock: t.in_stock + Number(p.stock.in_stock),
      out: t.out + Number(p.stock.out),
      lost: t.lost + Number(p.stock.lost),
    }),
    { units: 0, in_stock: 0, out: 0, lost: 0 },
  )
  const shown = (products ?? []).filter(p =>
    `${p.name} ${p.sku ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()),
  )
  const q = query.trim().toUpperCase()
  const unitHits = q.length >= 2 ? localUnits.filter(u => u.code.includes(q)).sort((a, b) => a.code.localeCompare(b.code)) : []

  return (
    <>
      <PageHeader
        title="Inventory"
        description="Your products and every labelled unit. Open a product to generate and print labels."
        actions={
          <>
            {isOwner && (
              <button className="ghost" onClick={() => setImporting(true)} disabled={offline} data-testid="open-import">
                <Icon name="download" /> Import CSV
              </button>
            )}
            <button className="secondary" onClick={() => setStudio(true)} data-testid="open-labels">
              <Icon name="printer" /> Labels
            </button>
            {newButton}
          </>
        }
      />

      {offline ? (
        <Section>
          <EmptyState
            icon="wifiOff"
            title="Inventory needs a connection"
            action={
              <button className="secondary" onClick={load}>
                <Icon name="refresh" /> Try again
              </button>
            }
          >
            New label codes are created on the server. Scanning and stocktakes keep working offline.
          </EmptyState>
        </Section>
      ) : products === null ? (
        <Section>
          <p className="muted">Loading…</p>
        </Section>
      ) : products.length === 0 ? (
        <Section>
          <EmptyState icon="box" title="No products yet" action={newButton}>
            A product is a type of item (e.g. “Castle 4×4”). Each physical one then gets its own label.
          </EmptyState>
        </Section>
      ) : (
        <>
          <div className="stats">
            <Stat label="Products" value={products.length} />
            <Stat label="Units" value={totals.units} />
            <Stat label="In stock" value={totals.in_stock} tone="ok" />
            <Stat label="Out / lost" value={`${totals.out} / ${totals.lost}`} tone={totals.lost ? 'error' : totals.out ? 'warn' : ''} />
          </div>
          {unitHits.length > 0 && (
            <Section flush title="Units" description="Codes matching your search — open one to manage it">
              <ul className="list" data-testid="unit-hits">
                {unitHits.slice(0, 20).map(u => (
                  <li key={u.id} className="clickable" onClick={() => openUnit(u.code)}>
                    <div className="li-main">
                      <span className="li-title mono">{u.code}</span>
                      <span className="li-sub">{u.product}</span>
                    </div>
                    <div className="li-end">
                      <ConditionBadge unit={u} />
                      <StatusBadge status={u.status} />
                      <Icon name="chevronRight" size={16} />
                    </div>
                  </li>
                ))}
                {unitHits.length > 20 && <li className="muted small">+{unitHits.length - 20} more — type more of the code</li>}
              </ul>
            </Section>
          )}
          <Section
            flush
            title="Products"
            actions={
              <div className="input-icon" style={{ width: 240, maxWidth: '100%' }}>
                <Icon name="search" size={16} />
                <input placeholder="Search name, SKU or code — or scan" value={query} onChange={e => setQuery(e.target.value)} aria-label="Search products" />
              </div>
            }
          >
            {shown.length === 0 && unitHits.length > 0 ? (
              <p className="muted small" style={{ padding: '14px 20px' }}>No product names match — see the units above.</p>
            ) : shown.length === 0 ? (
              <EmptyState icon="search" title="No matches">
                Nothing matches “{query}”.
              </EmptyState>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Product</th>
                      <th className="hide-sm">Availability</th>
                      <th className="num">In stock</th>
                      <th className="num">Out</th>
                      <th className="num">Lost</th>
                      <th className="num hide-sm">Total</th>
                      <th aria-label="Open" />
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map(p => {
                      const t = Number(p.stock.total) || 1
                      return (
                        <tr key={p.id} className="clickable" onClick={() => setSelected(p.id)}>
                          <td className="primary-cell">
                            {p.name}
                            {Number(p.stock.damaged) > 0 && (
                              <>
                                {' '}
                                <Badge tone="error">{p.stock.damaged} damaged</Badge>
                              </>
                            )}
                            {(p.code_stem || p.sku) && (
                              <div className="muted small mono">
                                {p.code_stem ? `${p.code_stem}-${'0'.repeat(p.code_digits - 1)}1` : p.category === 'BLO' ? 'codes by hand' : p.sku}
                              </div>
                            )}
                          </td>
                          <td className="hide-sm">
                            <div className="stock-bar" title={`${p.stock.in_stock} in · ${p.stock.out} out · ${p.stock.lost} lost`}>
                              <span className="s-in" style={{ width: `${(p.stock.in_stock / t) * 100}%` }} />
                              <span className="s-out" style={{ width: `${(p.stock.out / t) * 100}%` }} />
                              <span className="s-lost" style={{ width: `${(p.stock.lost / t) * 100}%` }} />
                            </div>
                          </td>
                          <td className="num">{p.stock.in_stock}</td>
                          <td className="num">{p.stock.out}</td>
                          <td className={`num ${p.stock.lost ? 'error-text' : ''}`}>{p.stock.lost}</td>
                          <td className="num hide-sm">{p.stock.total}</td>
                          <td className="num muted">
                            <Icon name="chevronRight" size={16} />
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
        </>
      )}

      {importing && (
        <ImportModal
          orgId={orgId}
          onClose={() => setImporting(false)}
          onImported={async () => {
            setImporting(false)
            await load()
            engine.pullUnits(orgId).then(() => engine.listUnits(orgId)).then(setLocalUnits).catch(() => {})
          }}
        />
      )}
      {creating && (
        <NewProductModal
          orgId={orgId}
          onClose={() => setCreating(false)}
          onCreated={async id => {
            setCreating(false)
            await load()
            setSelected(id)
          }}
        />
      )}
    </>
  )
}

function ProductDetail({ engine, orgId, product, highlight, onBack, onChanged, onShowHistory }) {
  const ui = useUI()
  const [units, setUnits] = useState(null)
  const [count, setCount] = useState(1)
  const [busy, setBusy] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [checked, setChecked] = useState(new Set())
  const [printing, setPrinting] = useState(null)
  const [showRetired, setShowRetired] = useState(false)
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState(false)
  const [managing, setManaging] = useState(null)
  const [manualCode, setManualCode] = useState('')
  const [nextCodes, setNextCodes] = useState([])
  const manual = product.category === 'BLO'
  const scheme = product.code_stem
    ? `${product.code_stem}-${'0'.repeat(product.code_digits - 1)}1, ${product.code_stem}-${'0'.repeat(product.code_digits - 1)}2 …`
    : manual
      ? 'codes entered by hand (e.g. BLO-C3)'
      : 'random 8-character codes'

  useEffect(() => {
    if (!generating || !product.code_stem) return
    supabase
      .rpc('next_codes', { p_product: product.id, p_count: Math.min(Number(count) || 1, 3) })
      .then(({ data }) => setNextCodes(data ?? []))
  }, [generating, count, product.id, product.code_stem])

  async function addManual(e) {
    e.preventDefault()
    const { data, error } = await supabase.rpc('add_unit_with_code', { p_product: product.id, p_code: manualCode })
    if (error) return ui.toast(error.message, 'error')
    ui.toast(`${data.code} added.`, 'ok')
    setManualCode('')
    setAdding(false)
    await load()
    setChecked(prev => new Set([...prev, data.id]))
    engine.pullUnits(orgId).catch(() => {})
  }

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('units')
      .select('id, code, status, last_moved_at, created_at, condition, condition_note')
      .eq('product_id', product.id)
      .order('created_at')
      .order('code')
      .limit(1000)
    if (error) ui.toast(error.message, 'error')
    else setUnits(data)
  }, [product.id, ui])

  useEffect(() => {
    load()
  }, [load])

  async function generate(e) {
    e.preventDefault()
    setBusy(true)
    const { data, error } = await supabase.rpc('generate_units', { p_product: product.id, p_count: Number(count) })
    setBusy(false)
    if (error) return ui.toast(error.message, 'error')
    setGenerating(false)
    await load()
    setChecked(new Set(data.map(u => u.id)))
    ui.toast(`${data.length} new label${data.length === 1 ? '' : 's'} created and selected — print them next.`, 'ok')
    engine.pullUnits(orgId).catch(() => {}) // make the new codes scannable offline
  }

  function toggle(id) {
    setChecked(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const visible = (units ?? []).filter(u => showRetired || u.status !== 'retired' || u.code === highlight)

  // Opened by a scan / code search: point at that unit.
  useEffect(() => {
    if (!highlight || !units) return
    document.querySelector(`[data-unit="${highlight}"]`)?.scrollIntoView({ block: 'center' })
  }, [highlight, units])
  const toPrint = visible.filter(u => checked.has(u.id))
  const allChecked = visible.length > 0 && visible.every(u => checked.has(u.id))

  if (printing) {
    return <Labels units={printing.map(u => ({ code: u.code, product: product.name }))} onClose={() => setPrinting(null)} />
  }

  return (
    <>
      <PageHeader
        back={{ label: 'Inventory', onClick: onBack }}
        title={product.name}
        description={
          <>
            Codes: <span className="mono">{scheme}</span>
            {product.sku && <span className="muted"> · SKU {product.sku}</span>}
          </>
        }
        actions={
          <>
            <button className="ghost" onClick={() => setEditing(true)} data-testid="edit-product">
              <Icon name="edit" /> Edit
            </button>
            <button className="secondary" disabled={!visible.length} onClick={() => setPrinting(toPrint.length ? toPrint : visible)}>
              <Icon name="printer" /> {toPrint.length ? `Print ${toPrint.length} selected` : `Print all (${visible.length})`}
            </button>
            <button className={manual ? 'primary' : 'secondary'} onClick={() => setAdding(true)}>
              <Icon name="keyboard" /> Add piece with code
            </button>
            {!manual && (
              <button className="primary" onClick={() => (manual ? setAdding(true) : setGenerating(true))}>
                <Icon name="plus" /> {manual ? 'Add piece with code' : 'Generate labels'}
              </button>
            )}
          </>
        }
      />

      <div className="stats">
        <Stat label="In stock" value={product.stock.in_stock} tone="ok" />
        <Stat label="Out" value={product.stock.out} tone={product.stock.out ? 'warn' : ''} />
        <Stat label="Lost" value={product.stock.lost} tone={product.stock.lost ? 'error' : ''} />
        <Stat label="Total" value={product.stock.total} />
      </div>

      <Section
        flush
        title="Units"
        description={checked.size ? `${toPrint.length} selected` : 'Click a code to see its movement history'}
        actions={
          <label className="check" style={{ alignItems: 'center' }}>
            <input type="checkbox" checked={showRetired} onChange={e => setShowRetired(e.target.checked)} />
            <span className="small">Show retired</span>
          </label>
        }
      >
        {units === null ? (
          <p className="muted" style={{ padding: 20 }}>
            Loading…
          </p>
        ) : visible.length === 0 ? (
          <EmptyState
            icon="barcode"
            title="No units yet"
            action={
              <button className="primary" onClick={() => (manual ? setAdding(true) : setGenerating(true))}>
                <Icon name={manual ? 'keyboard' : 'plus'} /> {manual ? 'Add piece with code' : 'Generate labels'}
              </button>
            }
          >
            {manual
              ? 'Add each piece with its exact code, then print the labels.'
              : 'Generate one label per physical item, print them and stick them on.'}
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 44 }}>
                    <input
                      type="checkbox"
                      aria-label="Select all"
                      checked={allChecked}
                      onChange={() => setChecked(allChecked ? new Set() : new Set(visible.map(u => u.id)))}
                    />
                  </th>
                  <th>Code</th>
                  <th>Status</th>
                  <th className="hide-sm">Last moved</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {visible.map(u => (
                  <tr key={u.id} data-unit={u.code} className={u.code === highlight ? 'row-highlight' : ''}>
                    <td>
                      <input type="checkbox" aria-label={`Select ${u.code}`} checked={checked.has(u.id)} onChange={() => toggle(u.id)} />
                    </td>
                    <td>
                      <button className="link mono" title="Movement history" onClick={() => onShowHistory(u.code)}>
                        {u.code}
                      </button>
                    </td>
                    <td>
                      <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                        <StatusBadge status={u.status} />
                        <ConditionBadge unit={u} />
                      </span>
                    </td>
                    <td className="muted small hide-sm">{u.last_moved_at ? timeAgo(u.last_moved_at) : 'Never'}</td>
                    <td className="num">
                      <button className="link" onClick={() => setManaging(u)} data-testid={`manage-${u.code}`}>
                        Manage
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {generating && (
        <form onSubmit={generate}>
          <Modal
            title="Generate labels"
            description={`New units for ${product.name}. Each gets a unique 8-character code.`}
            onClose={() => setGenerating(false)}
            footer={
              <>
                <button type="button" className="secondary" onClick={() => setGenerating(false)}>
                  Cancel
                </button>
                <button className="primary" disabled={busy}>
                  {busy ? 'Generating…' : `Generate ${count || ''} label${Number(count) === 1 ? '' : 's'}`}
                </button>
              </>
            }
          >
            <label>
              How many physical units?
              <input type="number" min={1} max={500} value={count} onChange={e => setCount(e.target.value)} />
              <span className="hint">
                {product.code_stem
                  ? nextCodes.length
                    ? `Next codes: ${nextCodes.join(', ')}${Number(count) > nextCodes.length ? ' …' : ''}`
                    : 'No piece numbers left for this pattern.'
                  : 'Up to 500 at a time. Random codes avoid 0/O and 1/I.'}
              </span>
            </label>
          </Modal>
        </form>
      )}
      {adding && (
        <form onSubmit={addManual}>
          <Modal
            title="Add piece with code"
            description="For a piece that already has a code (e.g. BLO-C3). Scan its label or type the code."
            onClose={() => setAdding(false)}
            footer={
              <>
                <button type="button" className="secondary" onClick={() => setAdding(false)}>
                  Cancel
                </button>
                <button className="primary" disabled={!manualCode.trim()}>
                  Add piece
                </button>
              </>
            }
          >
            <label>
              Code
              <input
                className="mono"
                value={manualCode}
                placeholder="e.g. BLO-C3"
                onChange={e => setManualCode(e.target.value.toUpperCase())}
                data-testid="manual-code"
              />
              <span className="hint">A–Z, 0–9 and hyphens. Must not be used by any other piece.</span>
            </label>
          </Modal>
        </form>
      )}
      {managing && (
        <UnitModal
          engine={engine}
          orgId={orgId}
          unit={managing}
          onClose={() => setManaging(null)}
          onChanged={async () => {
            await load()
            await onChanged()
          }}
          onShowHistory={onShowHistory}
        />
      )}
      {editing && (
        <EditProductModal
          product={product}
          onClose={() => setEditing(false)}
          onSaved={async () => {
            setEditing(false)
            await onChanged()
            engine.pullUnits(orgId).catch(() => {}) // product names are cached with the units
          }}
        />
      )}
    </>
  )
}

// Only name and SKU can change: category, theme, size and code scheme are
// fixed once created (labels may already be printed). The database enforces it.
function EditProductModal({ product, onClose, onSaved }) {
  const ui = useUI()
  const [name, setName] = useState(product.name)
  const [sku, setSku] = useState(product.sku ?? '')
  const [busy, setBusy] = useState(false)
  async function save(e) {
    e.preventDefault()
    setBusy(true)
    const { error } = await supabase
      .from('products')
      .update({ name: name.trim(), sku: sku.trim() || null })
      .eq('id', product.id)
    setBusy(false)
    if (error) return ui.toast(error.code === '23505' ? 'Another product already uses that SKU.' : error.message, 'error')
    ui.toast('Product updated.', 'ok')
    onSaved()
  }
  return (
    <Modal
      title="Edit product"
      description="Codes and labels don’t change. To change the theme or size, create a new product."
      onClose={onClose}
      size="sm"
      footer={
        <>
          <button className="ghost" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" form="edit-product" disabled={busy || !name.trim()}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <form id="edit-product" className="stack" onSubmit={save}>
        <label>
          Name
          <input value={name} onChange={e => setName(e.target.value)} maxLength={80} required />
        </label>
        <label>
          SKU <span className="hint">optional</span>
          <input value={sku} onChange={e => setSku(e.target.value)} maxLength={40} />
        </label>
      </form>
    </Modal>
  )
}
