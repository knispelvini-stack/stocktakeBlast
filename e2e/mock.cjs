// Test-only stand-in for Supabase: serves /rest/v1/rpc/* by calling the real
// SQL functions as role `authenticated` with the JWT's sub, plus a static
// server for the built app. NOT a PostgREST reimplementation — RPCs only.
const http = require('http')
const fs = require('fs')
const path = require('path')
const { Pool } = require('pg')

const DIST = process.argv[2]
const pool = new Pool({ database: process.env.PGDATABASE || 'e2e' } /* PGHOST, PGPORT, PGUSER from env */)
const stats = { rpc: 0 }

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS')
}

function sub(req) {
  const tok = (req.headers.authorization || '').replace(/^Bearer /, '')
  try {
    return JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString()).sub
  } catch {
    return null
  }
}

http
  .createServer(async (req, res) => {
    cors(res)
    if (req.method === 'OPTIONS') return res.end()
    const m = req.url.match(/^\/rest\/v1\/rpc\/(\w+)/)
    if (m && req.method === 'POST') {
      stats.rpc++
      let body = ''
      for await (const c of req) body += c
      const args = body ? JSON.parse(body) : {}
      const uid = sub(req)
      const client = await pool.connect()
      try {
        await client.query('begin')
        const { rows: fn } = await client.query(
          `select proretset from pg_proc where proname = $1 and pronamespace = 'public'::regnamespace`,
          [m[1]],
        )
        if (!fn.length) throw Object.assign(new Error('function not found'), { code: 'PGRST202' })
        await client.query(`set local role ${uid ? 'authenticated' : 'anon'}`)
        await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid || ''])
        const keys = Object.keys(args)
        const named = keys.map((k, i) => `${k} => $${i + 1}`).join(', ')
        const vals = keys.map(k => (args[k] !== null && typeof args[k] === 'object' ? JSON.stringify(args[k]) : args[k]))
        const sql = fn[0].proretset
          ? `select coalesce(jsonb_agg(t), '[]') as r from public.${m[1]}(${named}) t`
          : `select to_jsonb(public.${m[1]}(${named})) as r`
        const { rows } = await client.query(sql, vals)
        await client.query('commit')
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(rows[0].r))
      } catch (e) {
        await client.query('rollback').catch(() => {})
        res.statusCode = e.code === '42501' ? 403 : 400
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ code: e.code || 'XX000', message: e.message, details: null, hint: null }))
      } finally {
        client.release()
      }
      return
    }
    // Minimal PostgREST table reads: ?select=a,b&col=eq.v&order=c.desc,d&limit=n
    // (enough for the Products screen). Runs as `authenticated`, so RLS applies.
    const t = req.url.match(/^\/rest\/v1\/(\w+)\?(.*)$/)
    if (t && req.method === 'GET') {
      const params = new URLSearchParams(t[2])
      const ident = x => {
        if (!/^\w+$/.test(x)) throw new Error('bad identifier ' + x)
        return `"${x}"`
      }
      const client = await pool.connect()
      try {
        const sel = (params.get('select') || '*').split(',').map(c => (c === '*' ? '*' : ident(c))).join(', ')
        const where = []
        const vals = []
        for (const [k, v] of params) {
          if (['select', 'order', 'limit', 'offset'].includes(k)) continue
          const m = v.match(/^eq\.(.*)$/)
          if (m) {
            vals.push(m[1])
            where.push(`${ident(k)} = $${vals.length}`)
          }
        }
        const order = (params.get('order') || '')
          .split(',')
          .filter(Boolean)
          .map(o => {
            const [c, d] = o.split('.')
            return `${ident(c)} ${d === 'desc' ? 'desc' : 'asc'}`
          })
          .join(', ')
        const sql =
          `select coalesce(jsonb_agg(x), '[]') as r from (select ${sel} from public.${ident(t[1])}` +
          (where.length ? ` where ${where.join(' and ')}` : '') +
          (order ? ` order by ${order}` : '') +
          (params.get('limit') ? ` limit ${parseInt(params.get('limit'), 10)}` : '') +
          `) x`
        await client.query('begin')
        await client.query('set local role authenticated')
        await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [sub(req) || ''])
        const { rows } = await client.query(sql, vals)
        await client.query('commit')
        res.setHeader('Content-Type', 'application/json')
        return res.end(JSON.stringify(rows[0].r))
      } catch (e) {
        await client.query('rollback').catch(() => {})
        res.statusCode = 400
        res.setHeader('Content-Type', 'application/json')
        return res.end(JSON.stringify({ code: e.code || 'XX000', message: e.message }))
      } finally {
        client.release()
      }
    }
    // Minimal PostgREST writes: POST (insert, ?select=…, single object or array)
    // and PATCH (?col=eq.v). As `authenticated`, so RLS + triggers apply.
    const w = req.url.match(/^\/rest\/v1\/(\w+)(?:\?(.*))?$/)
    if (w && (req.method === 'POST' || req.method === 'PATCH') && !req.url.startsWith('/rest/v1/rpc/')) {
      const params = new URLSearchParams(w[2] || '')
      const ident = x => {
        if (!/^\w+$/.test(x)) throw new Error('bad identifier ' + x)
        return `"${x}"`
      }
      let body = ''
      for await (const c of req) body += c
      const client = await pool.connect()
      try {
        const data = JSON.parse(body || '{}')
        const rowsIn = Array.isArray(data) ? data : [data]
        const sel = (params.get('select') || '*').split(',').map(c => (c === '*' ? '*' : ident(c))).join(', ')
        await client.query('begin')
        await client.query('set local role authenticated')
        await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [sub(req) || ''])
        const out = []
        if (req.method === 'POST') {
          for (const row of rowsIn) {
            const cols = Object.keys(row)
            const { rows } = await client.query(
              `insert into public.${ident(w[1])} (${cols.map(ident).join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')}) returning ${sel}`,
              cols.map(c => row[c]),
            )
            out.push(...rows)
          }
        } else {
          const set = Object.keys(data)
          const vals = set.map(c => data[c])
          const where = []
          for (const [k, v] of params) {
            if (k === 'select') continue
            const m = v.match(/^eq\.(.*)$/)
            if (m) {
              vals.push(m[1])
              where.push(`${ident(k)} = $${vals.length}`)
            }
          }
          const { rows } = await client.query(
            `update public.${ident(w[1])} set ${set.map((c, i) => `${ident(c)} = $${i + 1}`).join(', ')}` +
              (where.length ? ` where ${where.join(' and ')}` : '') +
              ` returning ${sel}`,
            vals,
          )
          out.push(...rows)
        }
        await client.query('commit')
        res.setHeader('Content-Type', 'application/json')
        const single = (req.headers.accept || '').includes('vnd.pgrst.object')
        if (single && out.length !== 1) {
          res.statusCode = 406
          return res.end(JSON.stringify({ code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' }))
        }
        res.statusCode = req.method === 'POST' ? 201 : 200
        return res.end(JSON.stringify(single ? out[0] : out))
      } catch (e) {
        await client.query('rollback').catch(() => {})
        res.statusCode = e.code === '23505' ? 409 : e.code === '42501' ? 403 : 400
        res.setHeader('Content-Type', 'application/json')
        return res.end(JSON.stringify({ code: e.code || 'XX000', message: e.message }))
      } finally {
        client.release()
      }
    }
    // Anonymous sign-in (supabase.auth.signInAnonymously → POST /auth/v1/signup).
    if (req.url.startsWith('/auth/v1/signup') && req.method === 'POST') {
      const id = require('crypto').randomUUID()
      await pool.query('insert into auth.users (id, is_anonymous) values ($1, true)', [id])
      const exp = Math.floor(Date.now() / 1000) + 3600 * 24 * 365
      const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url')
      const token = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: id, role: 'authenticated', is_anonymous: true, exp })}.sig`
      const user = { id, aud: 'authenticated', role: 'authenticated', is_anonymous: true, app_metadata: {}, user_metadata: {}, identities: [] }
      res.setHeader('Content-Type', 'application/json')
      return res.end(JSON.stringify({ access_token: token, token_type: 'bearer', expires_in: 3600 * 24 * 365, expires_at: exp, refresh_token: 'r-' + id, user }))
    }
    if (req.url === '/__stats') return res.end(JSON.stringify(stats))
    res.statusCode = 404
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ code: 'PGRST000', message: 'not mocked: ' + req.url }))
  })
  .listen(5191)

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' }
http
  .createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    let file = path.join(DIST, p)
    if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html')
    res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream')
    fs.createReadStream(file).pipe(res)
  })
  .listen(5190)

console.log('mock up: app :5190, api :5191')
