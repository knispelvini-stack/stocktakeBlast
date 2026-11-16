import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createScanDetector, normalizeCode } from './scanDetector.js'

function feed(det, keys, gap, start = 1000) {
  let t = start
  const results = []
  for (const k of keys) {
    results.push(det.key(k, t))
    t += gap
  }
  return results
}

test('fast burst ending in Enter is a scan', () => {
  const scans = []
  const det = createScanDetector({ onScan: c => scans.push(c) })
  const res = feed(det, [...'AB12CD34', 'Enter'], 8)
  assert.deepEqual(scans, ['AB12CD34'])
  assert.equal(res.at(-1), true)
})

test('Tab terminator also works', () => {
  const scans = []
  const det = createScanDetector({ onScan: c => scans.push(c) })
  feed(det, [...'XYZ9', 'Tab'], 5)
  assert.deepEqual(scans, ['XYZ9'])
})

test('human-speed typing is ignored', () => {
  const scans = []
  const det = createScanDetector({ onScan: c => scans.push(c) })
  const res = feed(det, [...'hello', 'Enter'], 120)
  assert.deepEqual(scans, [])
  assert.equal(res.at(-1), false)
})

test('Enter after a pause does not emit stale buffer', () => {
  const scans = []
  const det = createScanDetector({ onScan: c => scans.push(c) })
  feed(det, [...'ABCD'], 5, 1000)
  det.key('Enter', 5000)
  assert.deepEqual(scans, [])
})

test('too-short bursts are ignored', () => {
  const scans = []
  const det = createScanDetector({ onScan: c => scans.push(c) })
  feed(det, ['A', 'B', 'Enter'], 5)
  assert.deepEqual(scans, [])
})

test('two consecutive scans', () => {
  const scans = []
  const det = createScanDetector({ onScan: c => scans.push(c) })
  feed(det, [...'AAAA', 'Enter'], 5, 1000)
  feed(det, [...'BBBB', 'Enter'], 5, 3000)
  assert.deepEqual(scans, ['AAAA', 'BBBB'])
})

test('modifier key names (Shift) are not buffered', () => {
  const scans = []
  const det = createScanDetector({ onScan: c => scans.push(c) })
  feed(det, ['Shift', 'A', 'Shift', 'B', 'C', 'D', 'Enter'], 5)
  assert.deepEqual(scans, ['ABCD'])
})

test('slow Bluetooth scanner works with a larger gap', () => {
  const scans = []
  const det = createScanDetector({ maxGapMs: 90, onScan: c => scans.push(c) })
  feed(det, [...'SLOW1234', 'Enter'], 70)
  assert.deepEqual(scans, ['SLOW1234'])
})

test('normalizeCode trims and uppercases', () => {
  assert.equal(normalizeCode('  ab12cd \n'), 'AB12CD')
  assert.equal(normalizeCode(null), '')
})
