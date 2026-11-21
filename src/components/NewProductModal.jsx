import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import Icon from './ui/Icon.jsx'
import { Modal, useUI } from './ui/ui.jsx'
import { CATEGORIES, bannerStem, cleanStem, normalizeSize, pieceCode, suggestPrefix, PREFIX_RE, SIZE_CODE_RE } from '../lib/itemCodes.js'

const NEW_THEME = '__new__'

export default function NewProductModal({ orgId, onClose, onCreated }) {
  const ui = useUI()
  const [type, setType] = useState('BAN')
  const [themes, setThemes] = useState([])
  const [themeId, setThemeId] = useState('')
  const [themeName, setThemeName] = useState('')
  const [prefix, setPrefix] = useState('')
  const [prefixEdited, setPrefixEdited] = useState(false)
  const [w, setW] = useState('')
  const [h, setH] = useState('')
  const [sizeCode, setSizeCode] = useState('')
  const [name, setName] = useState('')
  const [nameEdited, setNameEdited] = useState(false)
  const [sku, setSku] = useState('')
  const [stem, setStem] = useState('CAS')
  const [digits, setDigits] = useState(3)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    supabase
      .from('themes')
      .select('id, name, prefix')
      .eq('org_id', orgId)
      .order('name')
      .then(({ data }) => {
        setThemes(data ?? [])
        setThemeId(data?.length ? data[0].id : NEW_THEME)
      })
  }, [orgId])

  // sensible defaults per type
  useEffect(() => {
    if (type === 'CAS') {
      setStem('CAS')
      setDigits(3)
    } else if (type === 'OTHER') {
      setStem('')
      setDigits(2)
    }
  }, [type])

  const newTheme = themeId === NEW_THEME
  const theme = themes.find(t => t.id === themeId)
  const effPrefix = newTheme ? prefix : theme?.prefix ?? ''
  const effThemeName = newTheme ? themeName.trim() : theme?.name ?? ''
  const size = normalizeSize(w, h)
  const preview =
    type === 'BAN'
      ? bannerStem(effPrefix, size, sizeCode) && pieceCode(bannerStem(effPrefix, size, sizeCode), 1, 2)
      : type === 'CAS' || type === 'OTHER'
        ? cleanStem(stem) && pieceCode(cleanStem(stem), 1, digits)
        : ''
  const autoName = type === 'BAN' && effThemeName && size ? `${effThemeName} banner ${sizeCode || size}` : ''
  const finalName = (nameEdited ? name : autoName || name).trim()

  const problems = []
  if (type === 'BAN') {
    if (newTheme && !themeName.trim()) problems.push('Enter the theme name.')
    if (newTheme && !PREFIX_RE.test(prefix)) problems.push('Prefix: 2–6 letters/digits, starting with a letter.')
    if (newTheme && themes.some(t => t.prefix === prefix)) problems.push(`Prefix ${prefix} is already used by another theme.`)
    if (newTheme && themes.some(t => t.name.toLowerCase() === themeName.trim().toLowerCase()))
      problems.push('That theme already exists — pick it from the list (one prefix per theme).')
    if (!size) problems.push('Enter the size (width × height).')
    if (sizeCode && !SIZE_CODE_RE.test(sizeCode)) problems.push('Size code: a letter, then up to 3 letters/digits (e.g. C4).')
  }
  if (type === 'CAS' && !cleanStem(stem)) problems.push('Enter the code start (e.g. CAS).')
  if (!finalName) problems.push('Enter a product name.')

  async function submit(e) {
    e.preventDefault()
    if (problems.length) return ui.toast(problems[0], 'error')
    setSaving(true)
    try {
      let tId = themeId
      if (type === 'BAN' && newTheme) {
        const { data, error } = await supabase
          .from('themes')
          .insert({ org_id: orgId, name: themeName.trim(), prefix })
          .select('id')
          .single()
        if (error) {
          return ui.toast(error.code === '23505' ? 'That theme name or prefix is already used.' : error.message, 'error')
        }
        tId = data.id
      }
      const row = { org_id: orgId, name: finalName, sku: sku.trim() || null }
      if (type === 'BAN') Object.assign(row, { category: 'BAN', theme_id: tId, size, size_code: sizeCode || null })
      if (type === 'CAS') Object.assign(row, { category: 'CAS', code_stem: cleanStem(stem), code_digits: digits })
      if (type === 'BLO') Object.assign(row, { category: 'BLO' })
      if (type === 'OTHER' && cleanStem(stem)) Object.assign(row, { code_stem: cleanStem(stem), code_digits: digits })
      const { data, error } = await supabase.from('products').insert(row).select('id').single()
      if (error) {
        const msg =
          error.code === '23505'
            ? type === 'BAN'
              ? `A ${effThemeName} banner with code ${bannerStem(effPrefix, size, sizeCode)} already exists.`
              : 'That SKU already exists.'
            : error.message
        return ui.toast(msg, 'error')
      }
      ui.toast(`“${finalName}” created. Generate its labels next.`, 'ok')
      onCreated(data.id)
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={submit}>
      <Modal
        title="New product"
        description="A type of item. Each physical piece gets its own label with a code from this pattern."
        onClose={onClose}
        footer={
          <>
            <button type="button" className="secondary" onClick={onClose}>
              Cancel
            </button>
            <button className="primary" disabled={saving}>
              {saving ? 'Saving…' : 'Create product'}
            </button>
          </>
        }
      >
        <div className="type-picker" role="radiogroup" aria-label="Type">
          {Object.entries(CATEGORIES).map(([k, c]) => (
            <button
              type="button"
              key={k}
              role="radio"
              aria-checked={type === k}
              data-type={k}
              className={type === k ? 'active' : ''}
              onClick={() => setType(k)}
            >
              {c.label}
            </button>
          ))}
        </div>

        {type === 'BAN' && (
          <>
            <label>
              Theme
              <select value={themeId} onChange={e => setThemeId(e.target.value)}>
                {themes.map(t => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({t.prefix})
                  </option>
                ))}
                <option value={NEW_THEME}>+ New theme…</option>
              </select>
              {!newTheme && <span className="hint">Every size of this theme uses the prefix {theme?.prefix}.</span>}
            </label>
            {newTheme && (
              <div className="form-row">
                <label>
                  Theme name
                  <input
                    value={themeName}
                    placeholder="e.g. Paw Patrol"
                    onChange={e => {
                      setThemeName(e.target.value)
                      if (!prefixEdited) setPrefix(suggestPrefix(e.target.value))
                    }}
                  />
                </label>
                <label>
                  Prefix
                  <input
                    className="mono"
                    value={prefix}
                    maxLength={6}
                    placeholder="PAW"
                    onChange={e => {
                      setPrefixEdited(true)
                      setPrefix(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))
                    }}
                  />
                  <span className="hint">Fixed forever, used for every size. 3 letters keeps barcodes easy to scan.</span>
                </label>
              </div>
            )}
            <label>
              Size
              <div className="size-row">
                <input type="text" inputMode="numeric" aria-label="Width" placeholder="4" value={w} onChange={e => setW(e.target.value.replace(/\D/g, ''))} />
                <span>×</span>
                <input type="text" inputMode="numeric" aria-label="Height" placeholder="5" value={h} onChange={e => setH(e.target.value.replace(/\D/g, ''))} />
              </div>
              <span className="hint">Whole numbers: 4.5 m → 45.</span>
            </label>
            <label>
              Size code <span className="hint">optional — a name your team uses for this size, e.g. C4</span>
              <input
                className="mono"
                value={sizeCode}
                maxLength={4}
                placeholder="blank = size digits"
                onChange={e => setSizeCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
                data-testid="size-code"
              />
            </label>
          </>
        )}

        {(type === 'CAS' || type === 'OTHER') && (
          <div className="form-row">
            <label>
              Code start {type === 'OTHER' && <span className="hint">optional — blank = random codes</span>}
              <input className="mono" value={stem} placeholder={type === 'CAS' ? 'CAS' : 'e.g. TBL'} onChange={e => setStem(cleanStem(e.target.value))} />
              {type === 'CAS' && <span className="hint">Castle scheme not final. Castles sharing “CAS” share one numbering.</span>}
            </label>
            <label>
              Number of digits
              <select value={digits} onChange={e => setDigits(Number(e.target.value))}>
                {[2, 3, 4].map(d => (
                  <option key={d} value={d}>
                    {d} ({'0'.repeat(d - 1)}1)
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}

        {type === 'BLO' && (
          <div className="notice info">
            <Icon name="keyboard" />
            <div>Blower scheme isn’t final: you’ll add each piece with its exact code (e.g. BLO-C3).</div>
          </div>
        )}

        <label>
          Product name
          <input
            value={nameEdited ? name : autoName || name}
            placeholder={type === 'BAN' ? 'Filled in from theme and size' : 'e.g. Castle Blue 4×4'}
            onChange={e => {
              setNameEdited(true)
              setName(e.target.value)
            }}
          />
        </label>
        <label>
          SKU <span className="hint">optional — your own reference</span>
          <input value={sku} onChange={e => setSku(e.target.value)} />
        </label>

        <div className="code-preview">
          <span className="muted small">Labels will look like</span>
          <code>{type === 'BLO' ? 'BLO-…  (entered by hand)' : preview || (type === 'OTHER' ? 'random 8-character code' : '—')}</code>
          {preview && <span className="muted small">numbering continues if this code start is already in use</span>}
        </div>
      </Modal>
    </form>
  )
}
