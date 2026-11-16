// Audible feedback so the operator doesn't need to look at the screen.
let ctx = null

function tone(freq, ms, at = 0) {
  ctx ??= new (window.AudioContext || window.webkitAudioContext)()
  const t = ctx.currentTime + at
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = 'square'
  osc.frequency.value = freq
  gain.gain.setValueAtTime(0.08, t)
  gain.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000)
  osc.connect(gain).connect(ctx.destination)
  osc.start(t)
  osc.stop(t + ms / 1000)
}

export function beep(kind, enabled = true) {
  if (!enabled) return
  try {
    if (kind === 'ok') tone(1400, 90)
    else if (kind === 'warn') { tone(900, 90); tone(900, 90, 0.13) }
    else tone(220, 350) // error
  } catch {
    /* audio unavailable */
  }
}
