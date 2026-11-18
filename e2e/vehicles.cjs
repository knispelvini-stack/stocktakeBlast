// End-to-end: register a vehicle, load it by scanning its label, unload it.
const { chromium } = require('playwright')
const { Pool } = require('pg')
const assert = require('assert/strict')

const OUT = process.argv[2]
const pool = new Pool({ database: process.env.PGDATABASE || 'e2e' } /* PGHOST, PGPORT, PGUSER from env */)
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
  await page.mouse.click(2, 600) // page focus, not a field
  await page.keyboard.type(code, { delay: 6 })
  await page.keyboard.press('Enter')
}

;(async () => {
  const items = (await q(`select code from units where status = 'in_stock' order by code limit 3`)).map(r => r.code)
  assert.equal(items.length, 3, 'need 3 units in stock')
  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  await ctx.addInitScript(s => localStorage.setItem('sb-localhost-auth-token', s), ownerSession)
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  const flash = page.locator('.flash-title')
  const load = page.locator('[data-testid="vehicle-load"]')

  // ── owner registers a vehicle
  await page.goto('http://localhost:5190/')
  await page.waitForSelector('h1:has-text("Overview")')
  await page.click('[data-nav="settings"]')
  await page.click('[data-section="vehicles"]')
  await page.fill('input[placeholder="e.g. Van 2"]', 'Van 2')
  await page.fill('input[placeholder="e.g. ABC123"]', 'abc123')
  await page.click('button:has-text("Add vehicle")')
  await page.waitForSelector('td code:has-text("VEH-01")')
  const [veh] = await q(`select id, code, plate from vehicles where name = 'Van 2'`)
  assert.equal(veh.code, 'VEH-01')
  assert.equal(veh.plate, 'ABC123')
  await page.click('tr:has-text("Van 2") button:has-text("Print label")')
  await page.waitForSelector('.print-area .label-code:has-text("VEH-01")')
  await page.click('button.breadcrumb')
  step('Settings → Vehicles: “Van 2” added as VEH-01 (plate ABC123), label prints')

  // ── load: scan the van label, then items (one of them offline)
  await page.click('[data-nav="move"]')
  await page.waitForSelector('text=Ready to check OUT')
  await scan(page, 'VEH-01')
  await flash.filter({ hasText: 'Loading Van 2' }).waitFor()
  assert.equal(await page.locator('[data-testid="move-vehicle"]').inputValue(), veh.id, 'van selected by its label')
  await scan(page, items[0])
  await flash.filter({ hasText: 'On Van 2' }).waitFor()
  await scan(page, items[1])
  await load.locator(`code:has-text("${items[1]}")`).waitFor()
  await ctx.setOffline(true)
  await scan(page, items[2])
  await load.locator(`code:has-text("${items[2]}")`).waitFor()
  await page.locator('h2:has-text("On Van 2 now (3)")').waitFor()
  await page.screenshot({ path: `${OUT}/vehicles-1-loading.png`, fullPage: true })
  step(`scanned VEH-01 → “Loading Van 2”; 3 items on board (the 3rd while offline), list updates instantly`)

  await ctx.setOffline(false)
  await page.locator('.sidebar .sync-main').filter({ hasText: 'Synced' }).waitFor({ timeout: 20000 })
  const onVan = await q(
    `select u.code from movements m join units u on u.id = m.unit_id where m.vehicle_id = $1 and m.direction = 'out' order by u.code`,
    [veh.id],
  )
  assert.deepEqual(onVan.map(r => r.code), [...items].sort(), 'server has all 3 movements on Van 2')
  step('back online: all 3 check-outs reached the server with vehicle = Van 2')

  // ── overview groups by vehicle
  await page.click('[data-nav="overview"]')
  const group = page.locator('[data-testid="out-group"]').filter({ hasText: 'Van 2' })
  await group.waitFor()
  for (const c of items) await group.locator(`code:has-text("${c}")`).waitFor()
  step('Overview → “Out right now” shows Van 2 (ABC123) with its 3 items')

  // ── unload: what's still out with the van
  await page.click('[data-nav="move"]')
  await page.click('button:has-text("Check IN")')
  await scan(page, 'VEH-01')
  await flash.filter({ hasText: 'Unloading Van 2' }).waitFor()
  await page.locator('h2:has-text("Still out with Van 2 (3)")').waitFor()
  await scan(page, items[0])
  await flash.filter({ hasText: 'Checked in' }).waitFor()
  await scan(page, items[1])
  await page.locator('h2:has-text("Still out with Van 2 (1)")').waitFor()
  assert.equal(await load.locator('code').count(), 1)
  assert.equal(await load.locator('code').first().textContent(), items[2])
  await page.screenshot({ path: `${OUT}/vehicles-2-unloading.png`, fullPage: true })
  step(`unloading Van 2: after 2 scans the screen shows the 1 item that didn’t come back (${items[2]})`)

  // ── activity filter by vehicle
  await page.click('[data-nav="activity"]')
  await page.selectOption('[data-testid="history-vehicle"]', veh.id)
  await page.waitForFunction(() => [...document.querySelectorAll('tbody tr')].length === 5)
  assert.ok((await page.locator('tbody').textContent()).includes('Van 2'))
  step('Activity filtered by Van 2: 3 out + 2 in, vehicle shown on each row')

  assert.deepEqual(errors, [], 'no page errors')
  console.log('\nALL VEHICLE E2E CHECKS PASSED')
  await browser.close()
  await pool.end()
})().catch(e => {
  console.error('FAILED:', e.message)
  process.exit(1)
})
