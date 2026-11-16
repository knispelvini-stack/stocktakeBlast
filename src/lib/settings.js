// Per-device scanner settings (each warehouse PC/scanner can differ).
const KEY = 'stb.settings'
const DEFAULTS = { maxGapMs: 50, minLength: 3, sound: true }

export function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') }
  } catch {
    return { ...DEFAULTS }
  }
}

export function saveSettings(s) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    /* private mode: settings just won't persist */
  }
}
