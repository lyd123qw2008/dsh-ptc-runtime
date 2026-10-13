/**
 * Benchmark the in-process hot paths of the PTC capability face.
 *
 *   node scripts/bench-payload.mjs            # all cases
 *   node scripts/bench-payload.mjs --quick    # fewer iterations
 *
 * What this measures, and what it deliberately does NOT:
 *
 * It times the work this package does to a provider reply — mapping an MCP
 * envelope to blocks, normalizing `structuredContent` for a program, and the
 * catalog projections a mount/discovery performs. It does NOT time the provider
 * itself, process spawn, or the MCP transport: those are dominated by factors
 * outside this repository (the ~200ms per-program floor in DESIGN §5 is
 * `ctx.ptcRuntime` spawning a child, not this code).
 *
 * Every payload is built ONCE, before timing. Building it inside the timed
 * region measures construction, not the function under test — the first version
 * of this file made exactly that mistake and overstated `toLosslessJson` by 6x
 * (0.885ms vs 0.147ms on the ~150 KB case).
 *
 * Payload magnitudes are the real ones measured on 2026-10-12 (DESIGN §3.1): an
 * IDEA `search_text` reply is ~150k chars of structured JSON, Cua's `list_windows`
 * ~8k, Playwright's screenshot replies carry a base64 PNG.
 */
import { performance } from 'node:perf_hooks'
import { createHash } from 'node:crypto'
import { toLosslessJson, toResultBlocks, projectOperation, selectTools } from '../packages/runtime/dist/index.js'

const QUICK = process.argv.includes('--quick')
const WARMUP = QUICK ? 3 : 20
const ITERATIONS = QUICK ? 20 : 200

/** A PNG-ish base64 payload of the requested encoded size. */
function base64OfBytes(bytes) {
  return Buffer.alloc(bytes, 0xab).toString('base64')
}

/** Structured JSON shaped like a real code-search reply, at the requested magnitude. */
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

/** A list of windows with numbers, the shape Cua returns. */
function windowsPayload(count) {
  return {
    windows: Array.from({ length: count }, (_, index) => ({
      id: 1000 + index,
      pid: 5000 + index,
      title: `Window ${index} — some application`,
      bounds: { x: index, y: index * 2, width: 1280, height: 720 },
      onCurrentSpace: index % 3 === 0,
    })),
  }
}

/** One listed MCP tool, the shape `discoverOperations` projects. */
function listedTool(index) {
  return {
    name: `operation_${index}`,
    description: `Does thing number ${index}.\n\nMore detail on a second paragraph that is trimmed.`,
    inputSchema: {
      type: 'object',
      properties: Object.fromEntries(Array.from({ length: 8 }, (_, p) => [`param${p}`, { type: 'string', description: `Parameter ${p}` }])),
      required: ['param0'],
    },
    annotations: { readOnlyHint: index % 2 === 0 },
  }
}

const HOST = { providers: () => [], spec: () => undefined }
const SAVING_HOST = {
  providers: () => [],
  spec: () => undefined,
  saveImages: async (images) => images.map((_image, index) => ({ attachmentId: `att-${index}`, mediaType: 'image/png', bytes: 1 })),
}

// Built once, outside every timed region.
const P_1K = searchPayload(1_000)
const P_WINDOWS = windowsPayload(60)
const P_50K = searchPayload(50_000)
const P_150K = searchPayload(150_000)
const P_1M = searchPayload(1_000_000)
const P_TEXT_150K = { content: [{ type: 'text', text: JSON.stringify(P_150K) }] }
const PNG_500K = base64OfBytes(500_000)
const P_SHOT_META = { content: [{ type: 'text', text: 'Took a screenshot.' }, { type: 'image', data: PNG_500K, mimeType: 'image/png' }] }
const TOOLS_200 = Array.from({ length: 200 }, (_, index) => listedTool(index))
const SPEC = { id: 'idea', transport: 'streamable-http', url: 'http://127.0.0.1:64342/stream' }

const CASES = [
  { name: 'toLosslessJson · 1 KB', run: () => toLosslessJson(P_1K) },
  { name: 'toLosslessJson · windows 8 KB', run: () => toLosslessJson(P_WINDOWS) },
  { name: 'toLosslessJson · search 50 KB', run: () => toLosslessJson(P_50K) },
  { name: 'toLosslessJson · search 150 KB (IDEA)', run: () => toLosslessJson(P_150K) },
  { name: 'toLosslessJson · search 1 MB', run: () => toLosslessJson(P_1M) },
  { name: 'toResultBlocks · text-only 150 KB', run: () => toResultBlocks(HOST, 'idea', 'search_text', P_TEXT_150K, 'inline') },
  { name: 'toResultBlocks · screenshot meta 500 KB png', run: () => toResultBlocks(HOST, 'playwright', 'browser_take_screenshot', P_SHOT_META, 'metadata-only') },
  { name: 'toResultBlocks · screenshot inline 500 KB png', run: () => toResultBlocks(SAVING_HOST, 'playwright', 'browser_take_screenshot', P_SHOT_META, 'inline') },
  { name: 'projectOperation · 200 tools (discovery)', run: () => TOOLS_200.map(tool => projectOperation(tool, SPEC)) },
  { name: 'selectTools · 200 tools', run: () => selectTools(TOOLS_200, SPEC) },
  { name: 'sha256 over 500 KB base64 (reference)', run: () => createHash('sha256').update(PNG_500K).digest('hex') },
]

function stats(samples) {
  const sorted = [...samples].sort((left, right) => left - right)
  const at = fraction => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]
  return { median: at(0.5), p95: at(0.95), min: sorted[0] }
}

console.log(`node ${process.version} — warmup ${WARMUP}, iterations ${ITERATIONS}\n`)
console.log('case'.padEnd(48) + 'median'.padStart(11) + 'p95'.padStart(11) + 'min'.padStart(11))

const results = []
for (const entry of CASES) {
  for (let index = 0; index < WARMUP; index++) entry.run()
  const samples = []
  for (let index = 0; index < ITERATIONS; index++) {
    const started = performance.now()
    entry.run()
    samples.push(performance.now() - started)
  }
  const s = stats(samples)
  results.push({ name: entry.name, ...s })
  console.log(
    entry.name.padEnd(48)
    + `${s.median.toFixed(3)}ms`.padStart(11)
    + `${s.p95.toFixed(3)}ms`.padStart(11)
    + `${s.min.toFixed(3)}ms`.padStart(11),
  )
}

console.log('\n' + JSON.stringify(results))
