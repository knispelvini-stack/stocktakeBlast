// End-to-end: company that doesn't scan returns. Loads only; the weekly
// stocktake brings things back. Runs last (it finishes a stocktake with "update stock").
const { chromium } = require('playwright')
const { Pool } = require('pg')
const assert = require('assert/strict')

const OUT = process.argv[2]
const pool = new Pool({ database: process.env.PGDATABASE || 'e2e' })
const q = async (sql, p) => (await pool.query(sql, p)).rows
const OWNER = 'aaaaaaaa-0000-0000-0000-000000000001'
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url')
const ownerSession = JSON.stringify({
  access_token: `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: OWNER, role: 'authenticated', exp: 4102444800 })}.sig`,
  refresh_token: 'r', token_type: 'bearer', expires_in: 31536000, expires_at: 4102444800,
  user: { id: OWNER, email: 'ops@example.com', aud: 'authenticated', role: 'authenticated', is_anonymous: false, app_metadata: {}, user_metadata: {} },
})
const step = m => console.log('✓', m)
async function scan(page, code) {
  await page.mouse.click(2, 600)
  await page.keyboard.type(code, { delay: 6 })
  await page.keyboard.press('Enter')
}
async function eventually(fn, expected, ms = 15000) {
  const end = Date.now() + ms
  let got
  while (Date.now() < end) {
    got = await fn()
    if (JSON.stringify(got) === JSON.stringify(expected)) return
    await new Promise(r => setTimeout(r, 200))
  }
  assert.deepEqual(got, expected)
}

;(async () => {
  const [org] = await q(`select id from orgs limit 1`)
  const [van] = await q(`select id from vehicles where code = 'VEH-01'`)
  const fresh = await q(`select u.id, u.code from units u where u.status = 'in_stock' and u.condition = 'ok'
                         and not exists (select 1 from movements m where m.unit_id = u.id) order by code limit 2`)
  assert.equal(fresh.length, 2, 'need 2 never-moved units')
  const [x, y] = fresh
  // y: loaded 3 days ago on Van 2, then a stocktake 2 days ago didn't see it
  await q(`insert into movements (org_id, unit_id, direction, vehicle_id, reference, scanned_at) values ($1, $2, 'out', $3, 'Lee wedding', now() - interval '3 days')`, [org.id, y.id, van.id])
  await q(`update units set status = 'out', last_moved_at = now() - interval '3 days' where id = $1`, [y.id])
  await q(`insert into count_sessions (org_id, name, status, created_at, closed_at) values ($1, 'Week 46', 'closed', now() - interval '2 days', now() - interval '2 days')`, [org.id])

  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  await ctx.addInitScript(s => localStorage.setItem('sb-localhost-auth-token', s), ownerSession)
  const page = await ctx.newPage()
  global.pageRef = page
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  const flash = page.locator('.flash-title')
  const toast = t => page.locator('.toast').filter({ hasText: t }).first().waitFor()

  // ── owner: returns aren't scanned
  await page.goto('http://localhost:5190/')
  await page.waitForSelector('h1:has-text("Overview")')
  await page.click('[data-nav="settings"]')
  await page.click('[data-section="company"]')
  await page.uncheck('[data-testid="scan-returns"]')
  assert.equal(await page.locator('[data-testid="overdue-days"]').count(), 0, 'overdue setting hidden')
  await page.click('button:has-text("Save changes")')
  await toast('Company settings saved')
  assert.equal((await q(`select scan_returns from orgs`))[0].scan_returns, false)
  step('Settings → Company: “We scan items when they come back” turned off')

  // ── Overview: y wasn't seen in the last stocktake
  await page.click('[data-nav="overview"]')
  await page.locator(`[data-testid="overdue"] li:has-text("${y.code}")`).waitFor()
  const [lastClosed] = await q(`select name from count_sessions where status = 'closed' order by created_at desc limit 1`)
  assert.ok((await page.locator('section:has([data-testid="overdue"])').textContent()).includes(lastClosed.name))
  await page.locator('h2:has-text("Last loaded")').waitFor()
  step(`Overview → “Not seen in the last stocktake”: ${y.code} (loaded before the last finished stocktake); “Out right now” is now “Last loaded”`)

  // ── load x on Van 2, double scan, then "next day" it goes out again
  await page.click('[data-nav="move"]')
  await scan(page, 'VEH-01')
  await flash.filter({ hasText: 'Loading Van 2' }).waitFor()
  await scan(page, x.code)
  await flash.filter({ hasText: 'On Van 2' }).waitFor()
  await page.locator('h2', { hasText: /Loaded on Van 2 today/ }).waitFor()
  await page.locator(`[data-testid="vehicle-load"] code:has-text("${x.code}")`).waitFor()
  await scan(page, x.code)
  await flash.filter({ hasText: 'Already out' }).waitFor()
  await eventually(async () => (await q(`select count(*)::int n from movements where unit_id = $1`, [x.id]))[0].n, 1)
  step(`${x.code} loaded on Van 2; scanned again straight away → “Already out” (double scan, not recorded)`)

  await q(`update movements set scanned_at = scanned_at - interval '1 day' where unit_id = $1`, [x.id])
  await q(`update units set last_moved_at = last_moved_at - interval '1 day' where id = $1`, [x.id])
  await page.reload()
  await page.waitForSelector('h1:has-text("Overview")')
  await page.click('[data-nav="move"]')
  await page.waitForSelector('text=Ready to check OUT')
  await page.locator('.sidebar .sync-main').filter({ hasText: 'Synced' }).waitFor({ timeout: 20000 })
  await scan(page, 'VEH-01')
  await flash.filter({ hasText: 'Loading Van 2' }).waitFor()
  await page.locator('h2', { hasText: /Loaded on Van 2 today/ }).waitFor()
  assert.equal(await page.locator(`[data-testid="vehicle-load"] code:has-text("${x.code}")`).count(), 0, 'yesterday’s load not shown')
  await scan(page, x.code)
  await page.locator('.flash.ok').filter({ hasText: 'On Van 2' }).waitFor()
  await page.locator('.flash-sub:has-text("loaded again")').waitFor()
  await eventually(async () => (await q(`select count(*)::int n from movements where unit_id = $1 and direction = 'out' and applied`, [x.id]))[0].n, 2)
  await page.screenshot({ path: `${OUT}/noreturn-1-reload.png`, fullPage: true })
  step(`next day, ${x.code} (never checked in) loads again → accepted as a new load; the van panel shows only today’s loads`)

  // ── weekly stocktake: x is back, y is not, one in-stock unit is missing
  await page.click('[data-nav="count"]')
  await page.click('button:has-text("New stocktake")')
  await page.fill('.modal input', 'Week 47')
  await page.click('button:has-text("Start counting")')
  await page.waitForSelector('text=Ready to count')
  await scan(page, x.code)
  await page.locator('.flash.ok').filter({ hasText: 'back from a job' }).waitFor()
  const notBack = page.locator('[data-testid="not-back"]')
  await notBack.locator(`li:has-text("${y.code}")`).waitFor()
  const nb = await notBack.locator(`li:has-text("${y.code}")`).textContent()
  const [{ n: missed }] = await q(`select count(*)::int n from count_sessions where status = 'closed' and created_at > now() - interval '3 days'`)
  assert.ok(missed >= 1)
  assert.ok(nb.includes('Van 2') && nb.includes('Lee wedding') && nb.includes(`missed ${missed} stocktake`), nb)
  assert.equal(await notBack.locator(`li:has-text("${x.code}")`).count(), 0)
  await page.screenshot({ path: `${OUT}/noreturn-2-stocktake.png`, fullPage: true })
  step(`stocktake: ${x.code} scanned = “back from a job”; ${y.code} under “Not back” (Van 2 · Lee wedding · missed N stocktakes)`)

  await page.locator('.sidebar .sync-main').filter({ hasText: 'Synced' }).waitFor({ timeout: 20000 })
  await page.click('button:has-text("Finish stocktake")')
  await page.locator('.modal').filter({ hasText: 'loaded but not seen since' }).waitFor()
  // "update stock" is off by default; with many missing it needs a second confirmation
  await page.locator('[data-testid="finish-count"]:has-text("Finish without changing stock")').waitFor()
  await page.check('[data-testid="apply-stock"]')
  const finish = page.locator('[data-testid="finish-count"]')
  await finish.filter({ hasText: /Finish and mark \d+ lost/ }).waitFor()
  if (await page.locator('[data-testid="apply-sure"]').count()) {
    assert.ok(await finish.isDisabled(), 'big loss needs the second tick')
    await page.check('[data-testid="apply-sure"]')
  }
  await finish.click()
  await toast('not back (still out)')
  const st = Object.fromEntries((await q(`select id, status from units where id = any($1)`, [[x.id, y.id]])).map(r => [r.id, r.status]))
  assert.equal(st[x.id], 'in_stock', 'scanned → back in stock')
  assert.equal(st[y.id], 'out', 'not back → stays out')
  step(`finish with “update stock”: ${x.code} back in stock, ${y.code} stays out (shows again next week), unscanned in-stock units → lost`)

  assert.deepEqual(errors, [], 'no page errors')
  console.log('\nALL NO-RETURN E2E CHECKS PASSED')
  await browser.close()
  await pool.end()
})().catch(async e => {
  await global.pageRef?.screenshot({ path: `${OUT}/noreturn-fail.png`, fullPage: true }).catch(() => {})
  console.error('FAILED:', e.message, OUT)
  process.exit(1)
})
