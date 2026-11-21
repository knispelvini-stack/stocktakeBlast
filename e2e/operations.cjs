// End-to-end: damage / repair, mark lost, overdue, CSV import, scan-to-open in
// Inventory, label CSV, removing a wrong stocktake scan. Runs after corrections.cjs.
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
// Poll the database until a query returns the expected value (sync is async).
async function eventually(sql, params, expected, ms = 15000) {
  const end = Date.now() + ms
  let got
  while (Date.now() < end) {
    got = (await q(sql, params))[0]?.n
    if (got === expected) return
    await new Promise(r => setTimeout(r, 200))
  }
  assert.equal(got, expected, sql)
}

async function scan(page, code) {
  await page.mouse.click(2, 600)
  await page.keyboard.type(code, { delay: 6 })
  await page.keyboard.press('Enter')
}

;(async () => {
  const [org] = await q(`select id from orgs limit 1`)
  // an item out for 6 days (overdue with the default 3)
  const [old] = await q(`select u.id, u.code from units u where u.status = 'in_stock' and not exists (select 1 from movements m where m.unit_id = u.id) order by code limit 1`)
  await q(`insert into movements (org_id, unit_id, direction, reference, scanned_at) values ($1, $2, 'out', 'Smith party', now() - interval '6 days')`, [org.id, old.id])
  await q(`update units set status = 'out', last_moved_at = now() - interval '6 days' where id = $1`, [old.id])

  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true })
  await ctx.addInitScript(s => localStorage.setItem('sb-localhost-auth-token', s), ownerSession)
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  const flash = page.locator('.flash-title')
  const toast = t => page.locator('.toast').filter({ hasText: t }).first().waitFor()

  await page.goto('http://localhost:5190/')
  await page.waitForSelector('h1:has-text("Overview")')
  await page.locator(`[data-testid="overdue"] li:has-text("${old.code}")`).waitFor()
  assert.ok((await page.locator('[data-testid="overdue"]').textContent()).includes('Smith party'))
  step(`Overview → Overdue lists ${old.code} (out 6 days, “Smith party”)`)

  // ── owner changes the limit to 7 days → no longer overdue
  await page.click('[data-nav="settings"]')
  await page.click('[data-section="company"]')
  await page.fill('[data-testid="overdue-days"]', '7')
  await page.click('button:has-text("Save changes")')
  await toast('Company settings saved')
  assert.equal((await q(`select overdue_days from orgs`))[0].overdue_days, 7)
  await page.click('[data-nav="overview"]')
  await page.waitForSelector('h1:has-text("Overview")')
  await page.waitForTimeout(300)
  assert.equal(await page.locator('[data-testid="overdue"]').count(), 0)
  step('Settings → Company: overdue after 7 days → the 6-day item is no longer flagged')

  // ── damage reported while unloading
  const [d] = await q(`select code from units where status = 'out' and code like 'BAN-%' and id <> $1 order by code limit 1`, [old.id])
  const dcode = d?.code ?? (await q(`select code from units where status = 'out' order by code limit 1`))[0].code
  await page.click('[data-nav="move"]')
  await page.click('button:has-text("Check IN")')
  await scan(page, dcode)
  await flash.filter({ hasText: 'Checked in' }).waitFor()
  await page.click(`.feed li:has(code:text-is("${dcode}")) [data-testid="report-damage"]`)
  await page.fill('[data-testid="damage-note"]', 'torn seam')
  await page.click('button:has-text("Mark damaged")')
  await toast(`${dcode} marked damaged`)
  assert.deepEqual(Object.values((await q(`select condition, condition_note from units where code = $1`, [dcode]))[0]), ['damaged', 'torn seam'])
  // checking it out again warns
  await page.click('button:has-text("Check OUT")')
  await scan(page, dcode)
  await page.locator('.flash.warn').filter({ hasText: 'torn seam' }).waitFor()
  await page.click(`.feed li:has(code:text-is("${dcode}")) [data-testid="undo"] >> nth=0`)
  step(`${dcode}: checked in, “Damaged” → note saved; checking it out again shows a DAMAGED warning`)

  // ── Overview + Inventory show it; repair it via scan-to-open
  await page.click('[data-nav="overview"]')
  await page.locator(`[data-testid="damaged-list"] li:has-text("${dcode}")`).waitFor()
  await page.click('[data-nav="inventory"]')
  await page.waitForSelector('h1:has-text("Inventory")')
  await page.locator('td .badge-pill:has-text("1 damaged")').first().waitFor()
  await scan(page, dcode)
  await page.locator(`tr.row-highlight[data-unit="${dcode}"] [data-testid="damaged-badge"]`).waitFor()
  await page.click(`[data-testid="manage-${dcode}"]`)
  await page.click('[data-testid="unit-modal"] button:has-text("Mark repaired")')
  await toast(`${dcode} marked repaired`)
  assert.equal((await q(`select condition from units where code = $1`, [dcode]))[0].condition, 'ok')
  step(`Overview → Damaged list; Inventory badge “1 damaged”; scanning ${dcode} opens its row; Manage → repaired`)

  // ── mark lost
  const [l] = await q(`select code from units u join products p on p.id = u.product_id where p.name = $1 and u.status = 'in_stock' order by code limit 1`,
    [(await q(`select p.name from units u join products p on p.id = u.product_id where u.code = $1`, [dcode]))[0].name])
  await page.click(`[data-testid="manage-${l.code}"]`)
  await page.click('[data-testid="unit-modal"] button:has-text("Mark lost")')
  await page.locator('.modal button:has-text("Mark lost")').last().click()
  await toast(`${l.code} marked lost`)
  assert.equal((await q(`select status from units where code = $1`, [l.code]))[0].status, 'lost')
  step(`${l.code} marked lost from Inventory (logged)`)

  // ── label CSV export
  const [dl] = await Promise.all([page.waitForEvent('download'), (async () => {
    await page.click('button:has-text("Print all")')
    await page.click('[data-testid="labels-csv"]')
  })()])
  const csv = require('fs').readFileSync(await dl.path(), 'utf8')
  assert.ok(csv.includes('code,product') && csv.includes(dcode), 'csv has codes')
  await page.click('button.breadcrumb')
  step('Labels → “Codes (CSV)” downloads code + product for a label printer or print shop')

  // ── CSV import
  await page.click('button.breadcrumb')
  await page.click('[data-testid="open-import"]')
  await page.fill('[data-testid="import-text"]', 'type,name,theme,prefix,size,stem,quantity\nBAN,,Frozen,FRZ,3x4,,2\nOTHER,Chair,,,,CHR,3\nXXX,bad')
  await page.locator('.notice:has-text("Row 3")').waitFor()
  assert.ok(await page.locator('[data-testid="import-submit"]').isDisabled())
  await page.fill(
    '[data-testid="import-text"]',
    'type,name,theme,prefix,size,size_code,stem,quantity\nBAN,,Frozen,FRZ,3x4,,,2\nOTHER,Chair,,,,,CHR,3\nBAN,Frozen combo 4.5x6,Frozen,FRZ,45x6,C4,,1',
  )
  await page.click('[data-testid="import-submit"]')
  await toast('Imported 3 products and 6 labels')
  const imported = (await q(`select code from units where code like 'BAN-FRZ34-%' or code like 'BAN-FRZC4-%' or code like 'CHR-%' order by code`)).map(r => r.code)
  assert.deepEqual(imported, ['BAN-FRZ34-01', 'BAN-FRZ34-02', 'BAN-FRZC4-01', 'CHR-01', 'CHR-02', 'CHR-03'])
  await page.locator('td:has-text("Frozen banner 3x4")').waitFor()
  step('Import CSV: bad row blocked in preview; 3 products + 6 labels created (BAN-FRZ34-01..02, BAN-FRZC4-01 via size code, CHR-01..03)')

  // ── code search in Inventory
  await page.fill('input[aria-label="Search products"]', 'chr-0')
  await page.locator('[data-testid="unit-hits"] li:has-text("CHR-03")').click()
  await page.locator('tr.row-highlight[data-unit="CHR-03"]').waitFor()
  await page.click('button.breadcrumb')
  step('Inventory search “chr-0” lists units by code; clicking one opens it highlighted')

  // ── stocktake: remove a wrong scan (online → voided on the server)
  await page.click('[data-nav="count"]')
  await page.click('button:has-text("New stocktake")')
  await page.fill('.modal input', 'Shelf A')
  await page.click('button:has-text("Start counting")')
  await page.waitForSelector('text=Ready to count')
  await scan(page, 'CHR-01')
  await flash.filter({ hasText: 'Chair' }).waitFor()
  await scan(page, 'NOT-A-LABEL')
  await page.locator('.feed li:has(code:text-is("NOT-A-LABEL"))').waitFor()
  await page.locator('.sidebar .sync-main').filter({ hasText: 'Synced' }).waitFor({ timeout: 20000 })
  await page.click('.feed li:has(code:text-is("CHR-01")) [data-testid="remove-scan"]')
  await page.click('.feed li:has(code:text-is("NOT-A-LABEL")) [data-testid="remove-scan"]')
  await page.locator('.sidebar .sync-main').filter({ hasText: 'Synced' }).waitFor({ timeout: 20000 })
  const [sess] = await q(`select id from count_sessions where name = 'Shelf A'`)
  await eventually(`select count(*)::int n from count_scan_voids where session_id = $1 and restored_at is null`, [sess.id], 2)
  await page.locator('.unit-list:has-text("Unknown")').waitFor({ state: 'detached' }).catch(() => {})
  assert.equal(await page.locator('section:has(h2:has-text("Unknown codes"))').count(), 0, 'unknown list gone')
  await scan(page, 'CHR-01')
  await page.locator('.flash.ok').filter({ hasText: 'Chair' }).waitFor()
  await page.locator('.sidebar .sync-main').filter({ hasText: 'Synced' }).waitFor({ timeout: 20000 })
  await eventually(`select count(*)::int n from count_scan_voids where session_id = $1 and restored_at is null`, [sess.id], 1)
  await page.screenshot({ path: `${OUT}/operations-stocktake.png`, fullPage: true })
  step('Stocktake: wrong scans removed (voided on the server, rows kept); scanning CHR-01 again counts it again')

  assert.deepEqual(errors, [], 'no page errors')
  console.log('\nALL OPERATIONS E2E CHECKS PASSED')
  await browser.close()
  await pool.end()
})().catch(e => {
  console.error('FAILED:', e.message)
  process.exit(1)
})
