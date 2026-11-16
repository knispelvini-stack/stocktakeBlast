// End-to-end: staff device joins with the company PIN; owner removes it.
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
  await page.mouse.click(2, 300)
  await page.keyboard.type(code, { delay: 6 })
  await page.keyboard.press('Enter')
}

;(async () => {
  const browser = await chromium.launch()
  const errors = []

  // ── staff device: no session at all
  const staff = await browser.newContext({ viewport: { width: 1000, height: 800 } })
  const page = await staff.newPage()
  page.on('pageerror', e => errors.push(e.message))
  await page.goto('http://localhost:5190/')
  await page.waitForSelector('text=Company PIN')
  assert.equal(await page.locator('text=Create account').count(), 0, 'no sign-up on the entry screen')
  await page.screenshot({ path: `${OUT}/4-pin-screen.png` })
  step('fresh device shows the PIN screen (no sign-up, no create company)')

  await page.fill('input[autocomplete="name"]', 'Joao')
  await page.fill('.pin-input', '000000')
  await page.click('button:has-text("Enter")')
  await page.waitForSelector('text=Wrong PIN.')
  assert.equal((await q('select count(*)::int n from pin_attempts where not ok'))[0].n, 1, 'failed attempt recorded')
  step('wrong PIN rejected and recorded')

  await page.fill('.pin-input', '482915')
  await page.click('button:has-text("Enter")')
  await page.waitForSelector('text=Ready to check OUT')
  assert.equal(await page.locator('.tabs button:has-text("Admin")').count(), 0, 'staff has no Admin tab')
  step('right PIN: device joins, no Admin tab for staff')

  const [{ code }] = await q(`select code from units where status = 'in_stock' order by code limit 1`)
  await scan(page, code)
  await page.locator('.flash-title').filter({ hasText: 'Checked out' }).waitFor()
  await page.locator('.sync-main').filter({ hasText: 'Synced' }).waitFor()
  await page.click('.tabs button:has-text("History")')
  await page.waitForFunction(c => [...document.querySelectorAll('tbody tr')].some(tr => tr.textContent.includes(c) && tr.textContent.includes('Joao')), code)
  step(`staff scan synced; History shows “Joao” as who moved ${code}`)

  // a second device gets the PIN right on the FIRST try (regression: it used
  // to bounce back to the PIN screen because of a stale user id)
  const staff2 = await browser.newContext({ viewport: { width: 1000, height: 800 } })
  const p2 = await staff2.newPage()
  p2.on('pageerror', e => errors.push(e.message))
  await p2.goto('http://localhost:5190/')
  await p2.waitForSelector('text=Company PIN')
  await p2.fill('input[autocomplete="name"]', 'Maria')
  await p2.fill('.pin-input', '482915')
  await p2.click('button:has-text("Enter")')
  await p2.waitForSelector('text=Ready to check OUT', { timeout: 10000 })
  await staff2.close()
  step('second device: right PIN on the first try goes straight in')

  // reload: still signed in (PIN only once per device)
  await page.reload()
  await page.waitForSelector('text=Ready to check OUT')
  step('reload: device stays signed in, no PIN asked again')

  // ── owner removes the device
  const owner = await browser.newContext({ viewport: { width: 1000, height: 900 } })
  await owner.addInitScript(s => localStorage.setItem('sb-localhost-auth-token', s), ownerSession)
  const op = await owner.newPage()
  op.on('pageerror', e => errors.push(e.message))
  await op.goto('http://localhost:5190/')
  await op.click('.tabs button:has-text("Admin")')
  await op.waitForSelector('td:has-text("Joao")')
  await op.waitForSelector('text=last changed')
  await op.screenshot({ path: `${OUT}/5-admin.png`, fullPage: true })
  op.once('dialog', d => d.accept())
  await op.click('tr:has-text("Joao") button:has-text("Remove")')
  await op.waitForFunction(() => !document.body.textContent.includes('Joao'))
  step('owner sees Admin tab, device list with “Joao”, removes it')

  await page.reload()
  await page.waitForSelector('text=Company PIN')
  step('removed device is sent back to the PIN screen')

  assert.deepEqual(errors, [], 'no page errors')
  console.log('\nALL PIN E2E CHECKS PASSED')
  await browser.close()
  await pool.end()
})().catch(e => {
  console.error('FAILED:', e.message)
  process.exit(1)
})
