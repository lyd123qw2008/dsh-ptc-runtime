/**
 * End-to-end in-process benchmark of a realistic program run.
 *
 *   node scripts/bench-program.mjs [--calls N]
 *
 * This is the workload the package exists for: one program that calls several
 * providers and aggregates. It times `runDirect` — the path the mounted face
 * actually uses — with a fake connection, so the number is THIS repository's
 * overhead with provider latency removed.
 *
 * The point is proportion: a real program also pays ~200ms of child-process
 * spawn (DESIGN §5) plus real provider latency, so this measures whether the
 * in-process work is worth optimizing at all.
 */
import { performance } from 'node:perf_hooks'
import { runDirect } from '../packages/runtime/dist/index.js'

const CALLS = Number((process.argv.find(a => a.startsWith('--calls=')) ?? '').split('=')[1] ?? 20)
const WARMUP = 5
const ITERATIONS = 50

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

const SMALL = searchPayload(1_000)
const LARGE = searchPayload(150_000)
const PNG = Buffer.alloc(200_000, 0xab).toString('base64')

const operations = [
  { name: 'search_text', summary: 'Search', safety: 'read', inputSchema: { type: 'object', properties: {} } },
  { name: 'list_windows', summary: 'List', safety: 'read', inputSchema: { type: 'object', properties: {} } },
  { name: 'browser_take_screenshot', summary: 'Shot', safety: 'read', inputSchema: { type: 'object', properties: {} } },
]

/** A mixed program: mostly small replies, one large, one screenshot. */
function makeConnection() {
  let counter = 0
  return {
    id: 'fx',
    label: 'fixture',
    operations,
    async call(operation) {
      counter++
      if (operation === 'search_text') {
        return { content: [{ type: 'text', text: JSON.stringify(LARGE) }], structuredContent: LARGE }
      }
      if (operation === 'browser_take_screenshot') {
        return { content: [{ type: 'text', text: 'shot' }, { type: 'image', data: PNG, mimeType: 'image/png' }] }
      }
      return { content: [{ type: 'text', text: JSON.stringify(SMALL) }], structuredContent: SMALL }
    },
    async close() {},
  }
}

const connection = makeConnection()
const host = { providers: () => [connection], spec: () => undefined }

// One big call, the rest small, one screenshot: a realistic mix.
const calls = Array.from({ length: CALLS }, (_, index) => {
  if (index === 0) return { target: 'fx.search_text', deliver: 'metadata-only' }
  if (index === 1) return { target: 'fx.browser_take_screenshot', deliver: 'metadata-only' }
  return { target: 'fx.list_windows' }
})

const request = { calls }

async function bench(fn) {
  for (let index = 0; index < WARMUP; index++) await fn()
  const samples = []
  for (let index = 0; index < ITERATIONS; index++) {
    const started = performance.now()
    await fn()
    samples.push(performance.now() - started)
  }
  samples.sort((left, right) => left - right)
  return { median: samples[Math.floor(samples.length / 2)], min: samples[0], max: samples[samples.length - 1] }
}

const result = await bench(() => runDirect(host, request))
const perCall = result.median / CALLS

console.log(`node ${process.version} — ${CALLS} calls, warmup ${WARMUP}, iterations ${ITERATIONS}\n`)
console.log(`program total   median ${result.median.toFixed(3)}ms   min ${result.min.toFixed(3)}ms   max ${result.max.toFixed(3)}ms`)
console.log(`per call        ${perCall.toFixed(3)}ms`)
console.log(`\nfor proportion: the ctx.ptcRuntime spawn floor is ~200ms (DESIGN §5),`)
console.log(`so this in-process work is ${(result.median / 200 * 100).toFixed(1)}% of a single-program run's floor.`)

// Correctness guard: the benchmark must actually exercise the paths it claims.
const verify = await runDirect(host, request)
console.log(`\nsanity: ok=${verify.ok} calls=${verify.calls.length} data=${verify.calls[0].data ? 'present' : 'ABSENT'}`)
