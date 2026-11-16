// Item code scheme helpers (UI side). The database is the authority — it
// recomputes banner stems and allocates piece numbers — these only preview.
//
//   BAN-<THEME PREFIX><size digits>-NN   e.g. BAN-PAW45-01 (banner, Paw Patrol, 4x5, piece 01)
//   CAS-NNN                              castles (scheme not final)
//   BLO-…                                blowers: codes added by hand (scheme not final)

export const CATEGORIES = {
  BAN: { label: 'Banner', digits: 2, stemFixed: true },
  CAS: { label: 'Castle', digits: 3, defaultStem: 'CAS' },
  BLO: { label: 'Blower', manual: true },
  OTHER: { label: 'Other', digits: 2 },
}

export function normalizeSize(w, h) {
  const a = String(w ?? '').replace(/\D/g, '')
  const b = String(h ?? '').replace(/\D/g, '')
  return a && b ? `${a}x${b}` : ''
}

export function bannerStem(prefix, size) {
  if (!prefix || !size) return ''
  return `BAN-${prefix.toUpperCase()}${size.replace('x', '')}`
}

export function pieceCode(stem, n, digits = 2) {
  return `${stem}-${String(n).padStart(digits, '0')}`
}

export function cleanStem(s) {
  return String(s ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

// "Paw Patrol" → "PAW", "Frozen Elsa" → "FRO"; the owner can edit it.
export function suggestPrefix(themeName) {
  const letters = String(themeName ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, '')
    .trim()
  if (!letters) return ''
  return letters.replace(/\s+/g, '').slice(0, 3)
}

export const PREFIX_RE = /^[A-Z][A-Z0-9]{1,5}$/
export const CODE_RE = /^[A-Z0-9]+(-[A-Z0-9]+)*$/
