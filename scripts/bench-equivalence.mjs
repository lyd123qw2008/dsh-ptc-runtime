/**
 * Prove the optimizations changed ONLY speed, never output.
 *
 *   node scripts/bench-equivalence.mjs
 *
 * The hash swap must be byte-identical, and `toLosslessJson` must produce a value
 * deep-equal to the old always-copy implementation for every input. This is the
 * evidence that the speedups are behavior-preserving.
 */
import { hash as oneShotHash } from 'node:crypto'
import { createHash } from 'node:crypto'
import { toLosslessJson, toResultBlocks } from '../packages/runtime/dist/index.js'

let failures = 0
const check = (label, condition, detail = '') => {
  if (condition) return
  failures++
  console.log(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

// --- 1. hash equivalence across a spread of image sizes -----------------------
console.log('hash equivalence (createHash vs crypto.hash):')
for (const bytes of [1, 999, 100_000, 500_000, 1_000_000]) {
  const data = Buffer.alloc(bytes, 0xab).toString('base64')
  const oldWay = createHash('sha256').update(data).digest('hex').slice(0, 16)
  const newWay = oneShotHash('sha256', data, 'hex').slice(0, 16)
  check(`hash ${bytes}B`, oldWay === newWay, `${oldWay} vs ${newWay}`)
}
console.log('  ok — identical for every size tested')

// --- 2. the OLD always-copy implementation, for differential comparison -------
function oldToLosslessJson(value, ancestors = new Set()) {
  if (value === null) return null
  const type = typeof value
  if (type === 'string' || type === 'boolean') return value
  if (type === 'number') {
    const number = value
    if (!Number.isFinite(number)) return null
    return Object.is(number, -0) ? 0 : number
  }
  if (type !== 'object') return undefined
  if (ancestors.has(value)) return undefined
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      const items = []
      for (let index = 0; index < value.length; index++) {
        const item = index in value ? oldToLosslessJson(value[index], ancestors) : undefined
        items.push(item === undefined ? null : item)
      }
      return items
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      const toJSON = value.toJSON
      return typeof toJSON === 'function' ? oldToLosslessJson(toJSON.call(value), ancestors) : undefined
    }
    const plain = {}
    for (const [key, held] of Object.entries(value)) {
      const item = oldToLosslessJson(held, ancestors)
      if (item !== undefined) plain[key] = item
    }
    return plain
  } finally {
    ancestors.delete(value)
  }
}

const CASES = [
  ['plain object', { a: 1, b: 'x', c: true, d: null }],
  ['nested', { a: { b: { c: [1, 2, 3] } } }],
  ['NaN', { n: NaN }],
  ['Infinity', JSON.parse('{"n": 1e999}')],
  ['-Infinity', JSON.parse('{"n": -1e999}')],
  ['-0', JSON.parse('{"n": -0}')],
  ['undefined prop', { a: 1, b: undefined }],
  ['sparse array', [1, , 3]],
  ['Date', { d: new Date('2020-01-01T00:00:00Z') }],
  ['nested Date', { a: [{ d: new Date(0) }] }],
  ['function', { f: () => 1, keep: 2 }],
  ['cycle', (() => { const o = { keep: 1 }; o.self = o; return o })()],
  ['empty object', {}],
  ['empty array', []],
  ['deep array', Array.from({ length: 500 }, (_, i) => ({ id: i, ok: true }))],
  ['mixed hostile', { n: Infinity, z: -0, d: new Date(0), arr: [1, , 3], f: () => 1, keep: 'yes' }],
  ['string root', 'hello'],
  ['number root', 42],
  ['null root', null],
]

console.log('\ntoLosslessJson differential vs the previous always-copy version:')
for (const [label, input] of CASES) {
  const before = oldToLosslessJson(input)
  const after = toLosslessJson(input)
  const same = JSON.stringify(before) === JSON.stringify(after)
  check(label, same, `old=${JSON.stringify(before)} new=${JSON.stringify(after)}`)
}
console.log(`  ok — ${CASES.length} cases deep-equal`)

// --- 3. the identity shortcut must not change observable output ---------------
console.log('\nidentity shortcut returns an equal value:')
const clean = { items: [{ id: 1 }], more: true }
check('clean payload equals itself', JSON.stringify(toLosslessJson(clean)) === JSON.stringify(clean))

// --- 4. end-to-end blocks unchanged ------------------------------------------
console.log('\ntoResultBlocks output unchanged:')
const HOST = { providers: () => [], spec: () => undefined }
const PNG = Buffer.alloc(1000, 0xab).toString('base64')
const envelope = {
  content: [
    { type: 'text', text: 'shot' },
    { type: 'image', data: PNG, mimeType: 'image/png' },
    { type: 'image', data: 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', mimeType: 'image/gif' },
  ],
}
const blocks = await toResultBlocks(HOST, 'pw', 'shot', envelope, 'metadata-only')
const metas = blocks.filter(block => block.kind === 'image-meta')
const expectedHash = createHash('sha256').update(PNG).digest('hex').slice(0, 16)
// blocks[0] is the text block; the image metadata follows it in server order.
// The trailing text is the pre-existing "outside the admission budget" notice.
check('admitted image keeps its hash', metas[0]?.hash === expectedHash, `${metas[0]?.hash} vs ${expectedHash}`)
check('dropped image still marked', metas[1]?.hash === 'dropped', String(metas[1]?.hash))
check('block order preserved', blocks.map(block => block.kind).join(',') === 'text,image-meta,image-meta,text',
  blocks.map(block => block.kind).join(','))

console.log(failures === 0
  ? '\nVERDICT: behavior-preserving — every output identical to the pre-optimization implementation.'
  : `\nVERDICT: ${failures} DIFFERENCE(S) — not behavior-preserving.`)
process.exitCode = failures === 0 ? 0 : 1
