// End-to-end: item code pattern + label creation, reprint and printing.
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
const codesOf = async name =>
  (await q(`select u.code, u.status from units u join products p on p.id = u.product_id where p.name = $1 order by u.code`, [name]))

;(async () => {
  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } })
  await ctx.addInitScript(s => localStorage.setItem('sb-localhost-auth-token', s), ownerSession)
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  const dialog = page.locator('[role="dialog"]')
  const toast = t => page.locator('.toast').filter({ hasText: t }).waitFor()

  await page.goto('http://localhost:5190/')
  await page.waitForSelector('h1:has-text("Overview")')
  await page.click('[data-nav="inventory"]')
  await page.waitForSelector('h1:has-text("Inventory")')

  // ── banner with a new theme: BAN-PAW45-NN
  await page.click('button:has-text("New product")')
  await dialog.locator('[data-type="BAN"]').click()
  await dialog.locator('select').first().selectOption('__new__')
  await dialog.locator('input[placeholder="e.g. Paw Patrol"]').fill('Paw Patrol')
  assert.equal(await dialog.locator('input[placeholder="PAW"]').inputValue(), 'PAW', 'prefix suggested from theme name')
  await dialog.locator('input[aria-label="Width"]').fill('4')
  await dialog.locator('input[aria-label="Height"]').fill('5')
  await dialog.locator('.code-preview code').filter({ hasText: 'BAN-PAW45-01' }).waitFor()
  await page.screenshot({ path: `${OUT}/labels-1-new-banner.png` })
  await dialog.locator('button:has-text("Create product")').click()
  await page.waitForSelector('h1:has-text("Paw Patrol banner 4x5")')
  step('new banner: theme Paw Patrol → prefix PAW, size 4×5 → preview BAN-PAW45-01, name filled in')

  await page.click('button:has-text("Generate labels")')
  await dialog.locator('input[type="number"]').fill('3')
  await dialog.locator('text=Next codes: BAN-PAW45-01, BAN-PAW45-02, BAN-PAW45-03').waitFor()
  await dialog.locator('button:has-text("Generate 3 labels")').click()
  await page.waitForSelector('button.link.mono:has-text("BAN-PAW45-03")')
  assert.deepEqual((await codesOf('Paw Patrol banner 4x5')).map(r => r.code), ['BAN-PAW45-01', 'BAN-PAW45-02', 'BAN-PAW45-03'])
  step('generate 3 → BAN-PAW45-01, -02, -03 (preview matched what the server created)')

  await page.click('tr:has-text("BAN-PAW45-02") button:has-text("Retire")')
  await dialog.locator('button:has-text("Retire unit")').click()
  await toast('BAN-PAW45-02 retired')
  assert.equal((await codesOf('Paw Patrol banner 4x5')).find(r => r.code === 'BAN-PAW45-02').status, 'retired')
  step('discarded piece → retired (row kept)')

  // ── same theme, other size reuses the prefix; duplicate banner is refused
  await page.click('button.breadcrumb')
  await page.click('button:has-text("New product")')
  await dialog.locator('select').first().selectOption({ label: 'Paw Patrol (PAW)' })
  await dialog.locator('input[aria-label="Width"]').fill('4')
  await dialog.locator('input[aria-label="Height"]').fill('5')
  await dialog.locator('button:has-text("Create product")').click()
  await toast('already exists')
  await dialog.locator('input[aria-label="Width"]').fill('3')
  await dialog.locator('input[aria-label="Height"]').fill('4')
  await dialog.locator('.code-preview code').filter({ hasText: 'BAN-PAW34-01' }).waitFor()
  await dialog.locator('button:has-text("Create product")').click()
  await page.waitForSelector('h1:has-text("Paw Patrol banner 3x4")')
  step('same theme, size 3×4 → BAN-PAW34 (same prefix); same theme+size twice is refused')

  // ── castle: CAS-001
  await page.click('button.breadcrumb')
  await page.click('button:has-text("New product")')
  await dialog.locator('[data-type="CAS"]').click()
  await dialog.locator('input[placeholder^="e.g. Castle"]').fill('Castle Blue')
  await dialog.locator('.code-preview code').filter({ hasText: 'CAS-001' }).waitFor()
  await dialog.locator('button:has-text("Create product")').click()
  await page.waitForSelector('h1:has-text("Castle Blue")')
  await page.click('button:has-text("Generate labels")')
  await dialog.locator('button:has-text("Generate 1 label")').click()
  await page.waitForSelector('button.link.mono:has-text("CAS-001")')
  step('castle → CAS-001')

  // ── blower: code by hand
  await page.click('button.breadcrumb')
  await page.click('button:has-text("New product")')
  await dialog.locator('[data-type="BLO"]').click()
  await dialog.locator('input[placeholder^="e.g. Castle"]').fill('Blower 1HP')
  await dialog.locator('button:has-text("Create product")').click()
  await page.waitForSelector('h1:has-text("Blower 1HP")')
  assert.equal(await page.locator('button:has-text("Generate labels")').count(), 0, 'blower has no generator')
  await page.click('button:has-text("Add piece with code")')
  await page.fill('[data-testid="manual-code"]', 'blo-c3')
  await dialog.locator('button:has-text("Add piece")').click()
  await page.waitForSelector('button.link.mono:has-text("BLO-C3")')
  step('blower → piece added by hand as BLO-C3')

  // ── Labels: reprint (same code) + new, then print
  await page.click('button.breadcrumb')
  await page.click('[data-testid="open-labels"]')
  await page.waitForSelector('h1:has-text("Labels")')
  await page.fill('[data-testid="reprint-code"]', 'ban-paw45-01')
  await page.press('[data-testid="reprint-code"]', 'Enter')
  await toast('BAN-PAW45-01 added')
  await page.fill('[data-testid="reprint-code"]', 'BAN-PAW45-02')
  await page.press('[data-testid="reprint-code"]', 'Enter')
  await toast('retired')
  await page.fill('[data-testid="reprint-code"]', 'NOPE-99')
  await page.press('[data-testid="reprint-code"]', 'Enter')
  await toast('isn’t a registered code')
  step('reprint: BAN-PAW45-01 added with the same code; retired and unknown codes refused')

  await page.selectOption('[data-testid="studio-product"]', { label: 'Paw Patrol banner 4x5 — BAN-PAW45-…' })
  await page.locator('text=Next: BAN-PAW45-04').waitFor()
  await page.click('button:has-text("Create and add to list")')
  await toast('BAN-PAW45-04')
  assert.equal(await page.locator('.list li').count(), 2)
  await page.screenshot({ path: `${OUT}/labels-2-studio.png` })
  step('new label from Labels screen → BAN-PAW45-04 (02 retired, 03 exist: numbers never reused)')

  await page.click('button:has-text("Print 2 labels")')
  await page.waitForSelector('.print-area .label svg rect')
  assert.deepEqual(await page.$$eval('.print-area .label-code', els => els.map(e => e.textContent)), ['BAN-PAW45-01', 'BAN-PAW45-04'])
  await page.selectOption('[data-testid="label-symbol"]', 'qr')
  await page.waitForSelector('.label-qr-img svg path')
  await page.screenshot({ path: `${OUT}/labels-3-qr.png` })
  step('print preview: code text on each label; barcode and QR both render')

  assert.deepEqual(errors, [], 'no page errors')
  console.log('\nALL LABEL E2E CHECKS PASSED')
  await browser.close()
  await pool.end()
})().catch(e => {
  console.error('FAILED:', e.message)
  process.exit(1)
})
