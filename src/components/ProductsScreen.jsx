import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import Labels from './Labels.jsx'

export default function ProductsScreen({ engine, orgId, onShowHistory }) {
  const [products, setProducts] = useState(null)
  const [offline, setOffline] = useState(false)
  const [selected, setSelected] = useState(null)
  const [form, setForm] = useState({ name: '', sku: '' })
  const [query, setQuery] = useState('')

  const load = useCallback(async () => {
    const [{ data: prods, error }, { data: stock }] = await Promise.all([
      supabase.from('products').select('id, name, sku').eq('org_id', orgId).order('name'),
      supabase.from('product_stock').select('*').eq('org_id', orgId),
    ])
    if (error) {
      if (!error.code) return setOffline(true)
      return alert(error.message)
    }
    setOffline(false)
    const byId = Object.fromEntries((stock ?? []).map(s => [s.product_id, s]))
    setProducts(prods.map(p => ({ ...p, stock: byId[p.id] ?? { in_stock: 0, out: 0, lost: 0, total: 0 } })))
  }, [orgId])

  useEffect(() => {
    load()
  }, [load])

  async function add(e) {
    e.preventDefault()
    const { error } = await supabase
      .from('products')
      .insert({ org_id: orgId, name: form.name.trim(), sku: form.sku.trim() || null })
    if (error) return alert(error.code === '23505' ? 'That SKU already exists.' : error.message)
    setForm({ name: '', sku: '' })
    load()
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

  if (offline)
    return (
      <div className="stack">
        <div className="notice offline">
          Managing products and printing labels needs a connection (new codes are created on the server). Scanning still
          works offline.
        </div>
        <button className="ghost" onClick={load}>
          Try again
        </button>
      </div>
    )

  const shown = (products ?? []).filter(p =>
    `${p.name} ${p.sku ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()),
  )

  return (
    <div className="stack">
      <form className="card row wrap" onSubmit={add}>
        <label className="grow">
          Product name
          <input required value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="e.g. Castle 4x4" />
        </label>
        <label>
          SKU (optional)
          <input value={form.sku} onChange={e => setForm({ ...form, sku: e.target.value })} />
        </label>
        <button className="primary">Add product</button>
      </form>

      {products === null ? (
        <p className="muted">Loading…</p>
      ) : products.length === 0 ? (
        <p className="muted">Add your first product, then generate one label per physical unit.</p>
      ) : (
        <>
          <input placeholder="Search products…" value={query} onChange={e => setQuery(e.target.value)} />
          <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Product</th>
                <th className="num">In stock</th>
                <th className="num">Out</th>
                <th className="num">Lost</th>
                <th className="num">Total</th>
              </tr>
            </thead>
            <tbody>
              {shown.map(p => (
                <tr key={p.id} className="clickable" onClick={() => setSelected(p.id)}>
                  <td>
                    <strong>{p.name}</strong>
                    {p.sku && <span className="muted small"> · {p.sku}</span>}
                  </td>
                  <td className="num">{p.stock.in_stock}</td>
                  <td className="num">{p.stock.out}</td>
                  <td className={`num ${p.stock.lost ? 'error-text' : ''}`}>{p.stock.lost}</td>
                  <td className="num">{p.stock.total}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </>
      )}
    </div>
  )
}

function ProductDetail({ engine, orgId, product, onBack, onShowHistory }) {
  const [units, setUnits] = useState(null)
  const [count, setCount] = useState(1)
  const [busy, setBusy] = useState(false)
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
    if (error) alert(error.message)
    else setUnits(data)
  }, [product.id])

  useEffect(() => {
    load()
  }, [load])

  async function generate(e) {
    e.preventDefault()
    setBusy(true)
    const { data, error } = await supabase.rpc('generate_units', { p_product: product.id, p_count: Number(count) })
    setBusy(false)
    if (error) return alert(error.message)
    await load()
    setChecked(new Set(data.map(u => u.id)))
    engine.pullUnits(orgId).catch(() => {}) // make the new codes scannable offline
  }

  async function setStatus(unit, status) {
    const { error } = await supabase.from('units').update({ status }).eq('id', unit.id)
    if (error) return alert(error.message)
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

  if (printing) {
    return <Labels units={printing.map(u => ({ code: u.code, product: product.name }))} onClose={() => setPrinting(null)} />
  }

  return (
    <div className="stack">
      <div className="row wrap">
        <button className="ghost" onClick={onBack}>
          ← Products
        </button>
        <h2 className="grow">
          {product.name}
          {product.sku && <span className="muted small"> · {product.sku}</span>}
        </h2>
      </div>

      <form className="card row wrap" onSubmit={generate}>
        <label>
          New units
          <input type="number" min={1} max={500} value={count} onChange={e => setCount(e.target.value)} />
        </label>
        <button className="primary" disabled={busy}>
          {busy ? 'Generating…' : 'Generate labels'}
        </button>
        <span className="muted small grow">Each unit gets a unique 8-character code (no 0/O or 1/I, so it can't be misread).</span>
      </form>

      <div className="row wrap">
        <button className="secondary" disabled={!toPrint.length} onClick={() => setPrinting(toPrint)}>
          Print {toPrint.length || ''} selected
        </button>
        <button className="ghost" disabled={!visible.length} onClick={() => setPrinting(visible)}>
          Print all ({visible.length})
        </button>
        <button className="ghost" onClick={() => setChecked(checked.size ? new Set() : new Set(visible.map(u => u.id)))}>
          {checked.size ? 'Clear selection' : 'Select all'}
        </button>
        <label className="check grow end">
          <input type="checkbox" checked={showRetired} onChange={e => setShowRetired(e.target.checked)} />
          <span>Show retired</span>
        </label>
      </div>

      {units === null ? (
        <p className="muted">Loading…</p>
      ) : visible.length === 0 ? (
        <p className="muted">No units yet. Generate one label per physical item.</p>
      ) : (
        <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th />
              <th>Code</th>
              <th>Status</th>
              <th className="hide-sm">Last moved</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {visible.map(u => (
              <tr key={u.id}>
                <td>
                  <input type="checkbox" checked={checked.has(u.id)} onChange={() => toggle(u.id)} />
                </td>
                <td>
                  <button className="link mono" title="Movement history" onClick={() => onShowHistory(u.code)}>
                    {u.code}
                  </button>
                </td>
                <td>
                  <span className={`pill ${u.status}`}>{u.status.replace('_', ' ')}</span>
                </td>
                <td className="muted small hide-sm">{u.last_moved_at ? new Date(u.last_moved_at).toLocaleString() : '—'}</td>
                <td className="num">
                  {u.status === 'retired' ? (
                    <button className="link" onClick={() => setStatus(u, 'in_stock')}>
                      Restore
                    </button>
                  ) : (
                    <button
                      className="link"
                      onClick={() => confirm(`Retire ${u.code}? It will no longer be expected in stocktakes.`) && setStatus(u, 'retired')}
                    >
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
    </div>
  )
}
