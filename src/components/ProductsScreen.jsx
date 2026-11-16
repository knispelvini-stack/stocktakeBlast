import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import Labels from './Labels.jsx'
import Icon from './ui/Icon.jsx'
import { PageHeader, Section, EmptyState, Modal, StatusBadge, Stat, useUI, timeAgo } from './ui/ui.jsx'

export default function ProductsScreen({ engine, orgId, onShowHistory }) {
  const ui = useUI()
  const [products, setProducts] = useState(null)
  const [offline, setOffline] = useState(false)
  const [selected, setSelected] = useState(null)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState({ name: '', sku: '' })
  const [saving, setSaving] = useState(false)
  const [query, setQuery] = useState('')

  const load = useCallback(async () => {
    const [{ data: prods, error }, { data: stock }] = await Promise.all([
      supabase.from('products').select('id, name, sku').eq('org_id', orgId).order('name'),
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

  async function add(e) {
    e.preventDefault()
    setSaving(true)
    const { data, error } = await supabase
      .from('products')
      .insert({ org_id: orgId, name: form.name.trim(), sku: form.sku.trim() || null })
      .select('id')
      .single()
    setSaving(false)
    if (error) return ui.toast(error.code === '23505' ? 'That SKU already exists.' : error.message, 'error')
    setForm({ name: '', sku: '' })
    setCreating(false)
    ui.toast(`“${form.name.trim()}” added. Now generate its labels.`, 'ok')
    await load()
    if (data?.id) setSelected(data.id)
  }

  const product = products?.find(p => p.id === selected)
  if (product)
    return (
      <ProductDetail
        engine={engine}
        orgId={orgId}
        product={product}
        onShowHistory={onShowHistory}
        onBack={() => {
          setSelected(null)
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

  return (
    <>
      <PageHeader
        title="Inventory"
        description="Your products and every labelled unit. Open a product to generate and print labels."
        actions={newButton}
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
          <Section
            flush
            title="Products"
            actions={
              <div className="input-icon" style={{ width: 240, maxWidth: '100%' }}>
                <Icon name="search" size={16} />
                <input placeholder="Search name or SKU" value={query} onChange={e => setQuery(e.target.value)} aria-label="Search products" />
              </div>
            }
          >
            {shown.length === 0 ? (
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
                            {p.sku && <div className="muted small mono">{p.sku}</div>}
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

      {creating && (
        <form onSubmit={add}>
          <Modal
            title="New product"
            description="A type of item. You’ll generate one label per physical unit next."
            onClose={() => setCreating(false)}
            footer={
              <>
                <button type="button" className="secondary" onClick={() => setCreating(false)}>
                  Cancel
                </button>
                <button className="primary" disabled={saving || !form.name.trim()}>
                  {saving ? 'Saving…' : 'Create product'}
                </button>
              </>
            }
          >
            <label>
              Product name
              <input required value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="e.g. Castle 4×4" />
            </label>
            <label>
              SKU <span className="hint">optional — your own reference code</span>
              <input value={form.sku} onChange={e => setForm({ ...form, sku: e.target.value })} placeholder="e.g. CST-44" />
            </label>
          </Modal>
        </form>
      )}
    </>
  )
}

function ProductDetail({ engine, orgId, product, onBack, onShowHistory }) {
  const ui = useUI()
  const [units, setUnits] = useState(null)
  const [count, setCount] = useState(1)
  const [busy, setBusy] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [checked, setChecked] = useState(new Set())
  const [printing, setPrinting] = useState(null)
  const [showRetired, setShowRetired] = useState(false)

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('units')
      .select('id, code, status, last_moved_at, created_at')
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

  async function setStatus(unit, status) {
    if (status === 'retired') {
      const ok = await ui.confirm({
        title: `Retire ${unit.code}?`,
        body: 'Use this for a unit that was sold, scrapped or written off. It will no longer be expected in stocktakes. You can restore it later.',
        confirmLabel: 'Retire unit',
        danger: true,
      })
      if (!ok) return
    }
    const { error } = await supabase.from('units').update({ status }).eq('id', unit.id)
    if (error) return ui.toast(error.message, 'error')
    ui.toast(status === 'retired' ? `${unit.code} retired.` : `${unit.code} restored to stock.`, 'ok')
    load()
    engine.pullUnits(orgId).catch(() => {})
  }

  function toggle(id) {
    setChecked(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const visible = (units ?? []).filter(u => showRetired || u.status !== 'retired')
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
        description={product.sku ? <span className="mono">{product.sku}</span> : 'One row per physical unit and its label.'}
        actions={
          <>
            <button className="secondary" disabled={!visible.length} onClick={() => setPrinting(toPrint.length ? toPrint : visible)}>
              <Icon name="printer" /> {toPrint.length ? `Print ${toPrint.length} selected` : `Print all (${visible.length})`}
            </button>
            <button className="primary" onClick={() => setGenerating(true)}>
              <Icon name="plus" /> Generate labels
            </button>
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
              <button className="primary" onClick={() => setGenerating(true)}>
                <Icon name="plus" /> Generate labels
              </button>
            }
          >
            Generate one label per physical item, print them and stick them on.
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
                  <tr key={u.id}>
                    <td>
                      <input type="checkbox" aria-label={`Select ${u.code}`} checked={checked.has(u.id)} onChange={() => toggle(u.id)} />
                    </td>
                    <td>
                      <button className="link mono" title="Movement history" onClick={() => onShowHistory(u.code)}>
                        {u.code}
                      </button>
                    </td>
                    <td>
                      <StatusBadge status={u.status} />
                    </td>
                    <td className="muted small hide-sm">{u.last_moved_at ? timeAgo(u.last_moved_at) : 'Never'}</td>
                    <td className="num">
                      {u.status === 'retired' ? (
                        <button className="link" onClick={() => setStatus(u, 'in_stock')}>
                          Restore
                        </button>
                      ) : (
                        <button className="link danger-text" onClick={() => setStatus(u, 'retired')}>
                          Retire
                        </button>
                      )}
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
              <span className="hint">Up to 500 at a time. Codes avoid 0/O and 1/I so they can’t be misread.</span>
            </label>
          </Modal>
        </form>
      )}
    </>
  )
}
