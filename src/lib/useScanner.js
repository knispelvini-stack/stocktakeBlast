import { useEffect, useRef } from 'react'
import { createScanDetector, normalizeCode } from './scanDetector.js'

function isEditable(el) {
  return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))
}

// Global listener for keyboard-wedge scanners. Ignores keys typed into form
// fields — those go through <ScanInput> (the scanner types into it and its
// Enter submits the form), so both paths end in the same onScan.
export function useScanner(onScan, { enabled = true, maxGapMs = 50, minLength = 3 } = {}) {
  const cb = useRef(onScan)
  cb.current = onScan

  useEffect(() => {
    if (!enabled) return
    const det = createScanDetector({
      maxGapMs,
      minLength,
      onScan: code => cb.current(normalizeCode(code)),
    })
    function onKey(e) {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (isEditable(e.target)) {
        det.reset()
        return
      }
      if (det.key(e.key, performance.now())) e.preventDefault()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [enabled, maxGapMs, minLength])
}
