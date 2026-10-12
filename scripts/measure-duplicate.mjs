/**
 * Measure the duplicate-payload fix against the real IDEA response.
 *
 * Before: `structuredContent` (200,577 chars pretty) + the identical text block
 * (150,565 chars compact) — the model read the same search twice.
 *
 * Uses ONE captured envelope, then maps it through the real block builder, so
 * the two numbers come from the same bytes rather than two live calls.
 *
 * Usage: node scripts/measure-duplicate.mjs <projectPath>
 */

import { connectMcpProvider } from '../packages/runtime/dist/catalog.js'
import { toResultBlocks } from '../packages/runtime/dist/ptc.js'

const projectPath = process.argv[2]
if (projectPath === undefined) throw new Error('usage: node scripts/measure-duplicate.mjs <projectPath>')

const connection = await connectMcpProvider({
  id: 'idea',
  label: 'IntelliJ IDEA',
  transport: 'streamable-http',
  url: 'http://127.0.0.1:64342/stream',
})
const envelope = await connection.call('search_text', { q: 'package', projectPath })
await connection.close()

const content = Array.isArray(envelope?.content) ? envelope.content : []
const beforeChars =
  (envelope?.structuredContent === undefined ? 0 : JSON.stringify(envelope.structuredContent, null, 2).length)
  + content.filter(b => b?.type === 'text').reduce((n, b) => n + String(b.text ?? '').length, 0)
const beforeBlocks = beforeChars > 0 ? (envelope?.structuredContent === undefined ? 0 : 1) + content.filter(b => b?.type === 'text').length : 0

const after = await toResultBlocks({ providers: () => [], spec: () => undefined }, 'idea', 'search_text', envelope, 'inline')
const afterChars = after.reduce((n, b) => n + (b.kind === 'text' ? b.text.length : 0), 0)

console.log(`text blocks emitted: ${after.filter(b => b.kind === 'text').length} (was ${beforeBlocks})`)
console.log(`chars kept:         ${afterChars}`)
console.log(`chars before:       ${beforeChars}`)
console.log(`saved:              ${beforeChars - afterChars} (${Math.round((1 - afterChars / beforeChars) * 100)}%)`)