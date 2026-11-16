// Distinguishes a keyboard-wedge barcode scanner from a human typing.
//
// A USB/Bluetooth scanner in HID mode "types" the whole code in a burst
// (typically 2–20 ms between keys) and finishes with Enter (or Tab). Humans
// rarely go below ~60 ms between keystrokes. So: buffer printable keys while
// the gap stays under maxGapMs; on the terminator, emit if long enough.
//
// Pure logic (no DOM) so it can be unit-tested. useScanner wires it to window.

export function createScanDetector({ maxGapMs = 50, minLength = 3, onScan }) {
  let buffer = ''
  let lastAt = -Infinity

  return {
    // Returns true when the key completed a scan (caller should preventDefault).
    key(key, now) {
      if (now - lastAt > maxGapMs) buffer = ''
      lastAt = now

      if (key === 'Enter' || key === 'Tab') {
        const code = buffer
        buffer = ''
        if (code.length >= minLength) {
          onScan(code)
          return true
        }
        return false
      }

      if (key.length === 1) buffer += key
      return false
    },
    reset() {
      buffer = ''
      lastAt = -Infinity
    },
  }
}

export function normalizeCode(raw) {
  return String(raw ?? '').trim().toUpperCase()
}
