// End-to-end: undo a scan (offline and after sync), move a unit to another van,
// search the activity, edit a product. Runs after vehicles.cjs (Van 2 = VEH-01).
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

;(async () => {
  const [org] = await q(`select id from orgs limit 1`)
  await q(`insert into vehicles (org_id, name) values ($1, 'Van 3')`, [org.id])
  const vans = Object.fromEntries((await q(`select name, id from vehicles`)).map(v => [v.name, v.id]))
  const [x, y] = (await q(`select code from units where status = 'in_stock' and code !~ '^BAN' order by code limit 2`)).map(r => r.code)
  assert.ok(x && y, 'need 2 units in stock')

  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  await ctx.addInitScript(s => localStorage.setItem('sb-localhost-auth-token', s), ownerSession)
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  const flash = page.locator('.flash-title')
  const line = code => page.locator(`.feed li:has(code:text-is("${code}"))`).filter({ hasNotText: 'undo)' }).first()

  await page.goto('http://localhost:5190/')
  await page.waitForSelector('h1:has-text("Overview")')
  await page.click('[data-nav="move"]')
  await page.waitForSelector('text=Ready to check OUT')

  // ── wrong van after sync → Change van
  await scan(page, 'VEH-01')
  await flash.filter({ hasText: 'Loading Van 2' }).waitFor()
  await scan(page, x)
  await flash.filter({ hasText: 'On Van 2' }).waitFor()
  await line(x).locator('.sync-mark.ok').waitFor({ timeout: 15000 })
  await line(x).locator('button:has-text("Change van")').click()
  await page.locator('[data-testid="change-van"] button:has-text("Van 3")').click()
  await flash.filter({ hasText: 'On Van 3' }).waitFor()
  await page.locator('.sidebar .sync-main').filter({ hasText: 'Synced' }).waitFor({ timeout: 20000 })
  const mx = await q(
    `select m.direction, m.vehicle_id, m.corrects_id is not null as is_undo, m.applied from movements m join units u on u.id = m.unit_id
     where u.code = $1 order by m.scanned_at, m.created_at`, [x])
  assert.deepEqual(mx.map(m => [m.direction, m.is_undo, m.applied]), [['out', false, true], ['in', true, true], ['out', false, true]])
  assert.equal(mx[2].vehicle_id, vans['Van 3'])
  assert.equal((await q(`select status from units where code = $1`, [x]))[0].status, 'out')
  await page.screenshot({ path: `${OUT}/corrections-1-change-van.png`, fullPage: true })
  step(`${x} scanned onto Van 2, synced, then “Change van” → Van 3: server has out / undo / out (Van 3)`)

  // ── offline scan, undone before it is sent
  await ctx.setOffline(true)
  await scan(page, y)
  await flash.filter({ hasText: 'On Van 2' }).waitFor()
  await line(y).locator('[data-testid="undo"]').click()
  await line(y).filter({ hasText: 'removed before it was sent' }).waitFor()
  await ctx.setOffline(false)
  await page.locator('.sidebar .sync-main').filter({ hasText: 'Synced' }).waitFor({ timeout: 20000 })
  assert.equal((await q(`select count(*)::int n from movements m join units u on u.id = m.unit_id where u.code = $1`, [y]))[0].n, 0)
  assert.equal((await q(`select status from units where code = $1`, [y]))[0].status, 'in_stock')
  step(`${y} scanned offline then Undo: never reached the server, still in stock`)

  // ── activity: search + undo badges
  await page.click('[data-nav="activity"]')
  await page.fill('[data-testid="history-search"]', 'van 3')
  await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 1)
  await page.fill('[data-testid="history-search"]', x.slice(0, -1).toLowerCase())
  await page.locator(`tbody tr:has-text("${x}") .badge-pill:text-is("undone")`).waitFor()
  await page.locator(`tbody tr:has-text("${x}") .badge-pill:text-is("undo")`).first().waitFor()
  await page.fill('[data-testid="history-search"]', 'ops@')
  await page.waitForFunction(() => document.querySelectorAll('tbody tr').length >= 3)
  await page.screenshot({ path: `${OUT}/corrections-2-search.png`, fullPage: true })
  step('Activity search: by van name, partial code (shows “undone” + “undo”), by person')

  // ── edit a product
  await page.click('[data-nav="inventory"]')
  await page.click('text=Castle 4x4')
  await page.click('[data-testid="edit-product"]')
  await page.fill('#edit-product input >> nth=0', 'Castle 4x4 Blue')
  await page.fill('#edit-product input >> nth=1', 'C44')
  await page.click('button:has-text("Save")')
  await page.waitForSelector('h1:has-text("Castle 4x4 Blue")')
  const [p] = await q(`select name, sku from products where name like 'Castle 4x4%'`)
  assert.deepEqual([p.name, p.sku], ['Castle 4x4 Blue', 'C44'])
  step('Inventory → Edit product: name + SKU saved')

  assert.deepEqual(errors, [], 'no page errors')
  console.log('\nALL CORRECTION E2E CHECKS PASSED')
  await browser.close()
  await pool.end()
})().catch(e => {
  console.error('FAILED:', e.message)
  process.exit(1)
})
