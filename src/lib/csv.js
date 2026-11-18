// Small RFC 4180 CSV parser (quotes, escaped quotes, CRLF) + the product import mapping.

export function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  // Excel often saves with a BOM and ; as separator in some locales.
  const src = text.replace(/^﻿/, '')
  const firstLine = src.split(/\r?\n/, 1)[0] ?? ''
  const sep = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ','
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        field += '"'
        i++
      } else if (c === '"') quoted = false
      else field += c
    } else if (c === '"') quoted = true
    else if (c === sep) {
      row.push(field)
      field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += c
  }
  if (field !== '' || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter(r => r.some(f => f.trim() !== ''))
}

export const IMPORT_COLUMNS = ['type', 'name', 'sku', 'theme', 'prefix', 'size', 'stem', 'digits', 'quantity']

export const IMPORT_TEMPLATE = `type,name,sku,theme,prefix,size,stem,digits,quantity
BAN,,,Paw Patrol,PAW,4x5,,,3
CAS,Castle Blue 4x4,,,,,CAS,3,2
BLO,Blower 1hp,BL-1,,,,,,0
OTHER,Table 6ft,,,,,TBL,2,10
`

const TYPES = ['BAN', 'CAS', 'BLO', 'OTHER']

// → { rows: [{ type, name, sku, theme, prefix, size, stem, digits, quantity }], errors: [string] }
export function rowsToProducts(table) {
  if (!table.length) return { rows: [], errors: [] }
  const head = table[0].map(h => h.trim().toLowerCase())
  const errors = []
  if (!head.includes('type') || !(head.includes('name') || head.includes('theme'))) {
    return { rows: [], errors: ['The first line must be the column names (at least: type, name). Download the template.'] }
  }
  const unknown = head.filter(h => h && !IMPORT_COLUMNS.includes(h))
  if (unknown.length) errors.push(`Unknown column${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`)
  const rows = table.slice(1).map((cells, i) => {
    const r = {}
    head.forEach((h, j) => {
      if (IMPORT_COLUMNS.includes(h)) {
        const v = (cells[j] ?? '').trim()
        if (v !== '') r[h] = v
      }
    })
    r.type = (r.type || 'OTHER').toUpperCase()
    const n = i + 1
    if (!TYPES.includes(r.type)) errors.push(`Row ${n}: type must be BAN, CAS, BLO or OTHER`)
    if (r.type === 'BAN' && (!r.theme || !r.size)) errors.push(`Row ${n}: a banner needs theme and size`)
    if (r.type !== 'BAN' && !r.name) errors.push(`Row ${n}: name is required`)
    if (r.quantity && !/^\d+$/.test(r.quantity)) errors.push(`Row ${n}: quantity must be a whole number`)
    if (r.type === 'BLO' && Number(r.quantity) > 0) errors.push(`Row ${n}: blower codes are added by hand — use quantity 0`)
    return r
  })
  if (rows.length > 500) errors.push('At most 500 rows per import.')
  return { rows, errors }
}
