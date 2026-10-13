/**
 * Does anything here scale worse than linearly? An O(n^2) path would matter far
 * more than any micro-cost, because a provider CAN return a multi-megabyte reply.
 *
 *   node scripts/bench-scaling.mjs
 */
import { performance } from 'node:perf_hooks'
import { toLosslessJson, toResultBlocks } from '../packages/runtime/dist/index.js'

const HOST = { providers: () => [], spec: () => undefined }

function searchPayload(targetChars) {
  const items = []
  let size = 0
  let index = 0
  while (size < targetChars) {
    const item = {
      filePath: `src/main/java/com/montnets/modules/aim/service/impl/Generated${index}.java`,
      lineNumber: 100 + index,
      lineText: `    private static final String CONSTANT_${index} = "${'x'.repeat(60)}";`,
      score: index / 7,
      matched: index % 2 === 0,
    }
    items.push(item)
    size += JSON.stringify(item).length
    index++
  }
  return { items, total: items.length, truncated: false }
}

function bench(fn, iterations = 30) {
  for (let index = 0; index < 5; index++) fn()
  const samples = []
  for (let index = 0; index < iterations; index++) {
    const started = performance.now()
    fn()
    samples.push(performance.now() - started)
  }
  samples.sort((left, right) => left - right)
  return samples[Math.floor(samples.length / 2)]
}

const SIZES = [100_000, 250_000, 500_000, 1_000_000, 2_000_000, 4_000_000]

console.log('toLosslessJson — is it linear?\n')
console.log('chars'.padStart(12) + 'median'.padStart(12) + 'us per KB'.padStart(12) + 'ratio vs prev'.padStart(16))
let previous = null
for (const size of SIZES) {
  const payload = searchPayload(size)
  const actual = JSON.stringify(payload).length
  const ms = bench(() => toLosslessJson(payload))
  const perKb = (ms * 1000) / (actual / 1000)
  const ratio = previous === null ? '—' : `${(ms / previous).toFixed(2)}x`
  console.log(String(actual).padStart(12) + `${ms.toFixed(3)}ms`.padStart(12) + perKb.toFixed(2).padStart(12) + ratio.padStart(16))
  previous = ms
}

console.log('\ntoResultBlocks metadata-only (hash) — is it linear?\n')
console.log('bytes'.padStart(12) + 'median'.padStart(12) + 'us per KB'.padStart(12) + 'ratio vs prev'.padStart(16))
previous = null
for (const bytes of [100_000, 250_000, 500_000, 1_000_000, 2_000_000]) {
  const data = Buffer.alloc(bytes, 0xab).toString('base64')
  const envelope = { content: [{ type: 'image', data, mimeType: 'image/png' }] }
  const ms = bench(() => toResultBlocks(HOST, 'pw', 'shot', envelope, 'metadata-only'))
  const perKb = (ms * 1000) / (bytes / 1000)
  const ratio = previous === null ? '—' : `${(ms / previous).toFixed(2)}x`
  console.log(String(bytes).padStart(12) + `${ms.toFixed(3)}ms`.padStart(12) + perKb.toFixed(2).padStart(12) + ratio.padStart(16))
  previous = ms
}

console.log('\nA doubling in time for a doubling in size is linear (ratio ~2.00).')
console.log('A ratio that grows with size would indicate a superlinear path.')
