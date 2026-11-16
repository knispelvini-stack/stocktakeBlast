// End-to-end offline test against the real SQL (via mock.cjs).
const { chromium } = require('playwright')
const { Pool } = require('pg')
const assert = require('assert/strict')

const OUT = process.argv[2]
const pool = new Pool({ database: process.env.PGDATABASE || 'e2e' } /* PGHOST, PGPORT, PGUSER from env */)
const q = async (sql, p) => (await pool.query(sql, p)).rows
const UID = 'aaaaaaaa-0000-0000-0000-000000000001'

const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url')
const jwt = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: UID, role: 'authenticated', email: 'ops@example.com', exp: 4102444800 })}.sig`
const sessionJson = JSON.stringify({
  access_token: jwt,
  refresh_token: 'r',
  token_type: 'bearer',
  expires_in: 3600 * 24 * 365,
  expires_at: 4102444800,
  user: { id: UID, email: 'ops@example.com', aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {} },
})

const step = msg => console.log('✓', msg)

async function scan(page, code) {
  await page.mouse.click(2, 300) // focus the page, not a field
  await page.keyboard.type(code, { delay: 6 })
  await page.keyboard.press('Enter')
}

;(async () => {
  const [c1, c2, c3] = (await q('select code from units order by code')).map(r => r.code)
  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } })
  await ctx.addInitScript(s => localStorage.setItem('sb-localhost-auth-token', s), sessionJson)
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  const badge = page.locator('.sync-main')
  const flash = page.locator('.flash-title')

  // ── online start: cache warm-up + service worker install
  await page.goto('http://localhost:5190/')
  await page.waitForSelector('text=Ready to check OUT')
  await page.waitForFunction(() => navigator.serviceWorker?.controller || null, null, { timeout: 10000 }).catch(() => {})
  await page.reload() // second load is SW-controlled
  await page.waitForSelector('text=Ready to check OUT')
  assert.ok(await page.evaluate(() => !!navigator.serviceWorker.controller), 'service worker controls the page')
  await badge.filter({ hasText: 'Synced' }).waitFor()
  step('online: app loaded, service worker active, badge "Synced"')

  await scan(page, c1)
  await flash.filter({ hasText: 'Checked out' }).waitFor()
  await page.waitForFunction(() => document.querySelector('.feed li .time')?.textContent.includes('☁'))
  assert.equal((await q('select status from units where code=$1', [c1]))[0].status, 'out')
  step(`online scan ${c1}: instant feedback, confirmed by server, DB status = out`)

  // ── go offline
  await ctx.setOffline(true)
  await badge.filter({ hasText: 'Offline' }).waitFor()
  await scan(page, c2)
  await flash.filter({ hasText: 'Checked out' }).waitFor()
  await badge.filter({ hasText: 'Offline · 1 saved on device' }).waitFor()
  await scan(page, c2)
  await flash.filter({ hasText: 'Already out' }).waitFor()
  assert.equal((await q('select status from units where code=$1', [c2]))[0].status, 'in_stock', 'server untouched while offline')
  step(`offline scan ${c2}: "Checked out" instantly, re-scan says "Already out" from the local cache, server untouched`)

  // conflict: c3 scanned OUT offline, but another device checks it out+in later
  await scan(page, c3)
  await flash.filter({ hasText: 'Checked out' }).waitFor()
  await page.waitForTimeout(50)
  await q(`update units set status='in_stock', last_moved_at = now() where code=$1`, [c3])
  step(`offline scan ${c3}; meanwhile "another device" moved it later (conflict prepared)`)

  // ── reload while offline: app must still open and keep the queue
  await page.reload()
  await page.waitForSelector('text=Ready to check OUT', { timeout: 10000 })
  await badge.filter({ hasText: 'Offline · 3 saved on device' }).waitFor()
  await page.screenshot({ path: `${OUT}/1-offline-after-reload.png` })
  step('page reloaded while offline: app opens from cache, 3 scans still queued (incl. the repeat, which the server decides), still signed in')

  // offline history shows the pending rows
  await page.click('.tabs button:has-text("History")')
  await page.waitForSelector('text=waiting to sync')
  assert.equal(await page.locator('.pending-row').count(), 3)
  await page.waitForSelector('text=Offline — showing')
  step('History offline: 3 pending rows + cached movements')

  // ── offline stocktake
  await page.click('.tabs button:has-text("Stocktake")')
  await page.fill('input[placeholder^="Stocktake"]', 'Offline count')
  await page.click('button:has-text("Start counting")')
  await page.waitForSelector('text=Ready to count')
  await scan(page, c1)
  await flash.filter({ hasText: 'Found: Castle 4x4' }).waitFor() // c1 is out → "found"
  await scan(page, 'BADCODE9')
  await flash.filter({ hasText: 'Not in local list' }).waitFor()
  assert.ok(await page.locator('button:has-text("Finish stocktake")').isDisabled(), 'finish disabled offline')
  await page.screenshot({ path: `${OUT}/2-offline-stocktake.png` })
  step('offline stocktake: created, scans recorded, summary live, Finish disabled')

  // ── back online: everything syncs
  await ctx.setOffline(false)
  await badge.filter({ hasText: 'Synced' }).waitFor({ timeout: 20000 })
  await page.waitForSelector('.sync-att', { timeout: 5000 })
  const st = Object.fromEntries((await q('select code, status from units')).map(r => [r.code, r.status]))
  assert.equal(st[c2], 'out', 'offline move applied')
  assert.equal(st[c3], 'in_stock', 'older offline move did not override newer one')
  const late = await q(`select applied from movements m join units u on u.id=m.unit_id where u.code=$1`, [c3])
  assert.deepEqual(late.map(r => r.applied), [false], 'late move kept in history as not applied')
  const sess = await q(`select name, (select count(*) from count_scans s where s.session_id=c.id)::int n from count_sessions c`)
  assert.deepEqual(sess, [{ name: 'Offline count', n: 2 }])
  const dupCheck = await q('select count(*)::int n from movements')
  assert.equal(dupCheck[0].n, 3, 'no duplicate movements')
  await page.locator('button:has-text("Finish stocktake")').waitFor()
  assert.ok(!(await page.locator('button:has-text("Finish stocktake")').isDisabled()), 'finish enabled after sync')
  step('online again: queue drained, c2 out, c3 conflict resolved by scan time, session + 2 scans on server, no duplicates')

  // ── history + attention
  await page.click('.tabs button:has-text("History")')
  await page.waitForSelector('text=Needs attention (1)')
  await page.waitForSelector('.late-row')
  assert.equal(await page.locator('.pending-row').count(), 0)
  await page.screenshot({ path: `${OUT}/3-history-attention.png`, fullPage: true })
  // filter by scanning a label on the History screen
  await scan(page, c3)
  await page.waitForFunction(c => document.querySelector('input[placeholder="Scan or type"]').value === c, c3)
  await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 1)
  step('History: attention card for the conflict, "not applied" row, scan-to-filter works')

  // CSV export
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('button:has-text("Export CSV")')])
  const csv = require('fs').readFileSync(await dl.path(), 'utf8')
  assert.ok(csv.startsWith('scanned_at,code,product'))
  assert.ok(csv.includes('not applied (late)'))
  step('CSV export works')

  assert.deepEqual(errors, [], 'no page errors')
  console.log('\nALL OFFLINE E2E CHECKS PASSED')
  await browser.close()
  await pool.end()
})().catch(async e => {
  console.error('FAILED:', e.message)
  process.exit(1)
})
