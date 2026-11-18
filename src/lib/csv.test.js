import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCsv, rowsToProducts, IMPORT_TEMPLATE } from './csv.js'

test('parseCsv: quotes, escaped quotes, CRLF, blank lines, BOM', () => {
  assert.deepEqual(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n\r\n1,\n'), [
    ['a', 'b'],
    ['x, y', 'say "hi"'],
    ['1', ''],
  ])
})

test('parseCsv: semicolon files (Excel in some locales)', () => {
  assert.deepEqual(parseCsv('type;name\nCAS;Castle, blue'), [
    ['type', 'name'],
    ['CAS', 'Castle, blue'],
  ])
})

test('template parses without errors', () => {
  const { rows, errors } = rowsToProducts(parseCsv(IMPORT_TEMPLATE))
  assert.deepEqual(errors, [])
  assert.equal(rows.length, 4)
  assert.deepEqual(rows[0], { type: 'BAN', theme: 'Paw Patrol', prefix: 'PAW', size: '4x5', quantity: '3' })
})

test('rowsToProducts: catches the obvious, names the row', () => {
  const { errors } = rowsToProducts(parseCsv('type,name,size,theme,quantity,colour\nBAN,,,,1\nXXX,a\nBLO,b,,,2\nCAS,,,,x'))
  assert.deepEqual(errors, [
    'Unknown column: colour',
    'Row 1: a banner needs theme and size',
    'Row 2: type must be BAN, CAS, BLO or OTHER',
    'Row 3: blower codes are added by hand — use quantity 0',
    'Row 4: name is required',
    'Row 4: quantity must be a whole number',
  ])
  assert.match(rowsToProducts(parseCsv('foo,bar\n1,2')).errors[0], /column names/)
})
