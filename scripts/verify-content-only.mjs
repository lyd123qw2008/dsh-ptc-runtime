/**
 * Confirm the final rule against the real servers: render `content` only.
 *
 * Reports, per provider, how many text blocks reach the model and how many
 * characters `structuredContent` would have added. `structured chars ignored` is
 * the deliberate cost of the content-only rule (Cua Driver is the one that pays).
 *
 * Usage: node scripts/verify-content-only.mjs
 */

import { connectMcpProvider } from '../packages/runtime/dist/catalog.js'
import { toResultBlocks } from '../packages/runtime/dist/ptc.js'

const providers = [
  {
    spec: { id: 'idea', label: 'IntelliJ IDEA', transport: 'streamable-http', url: 'http://127.0.0.1:64342/stream' },
    probe: { operation: 'search_text', args: { q: 'package', projectPath: 'D:/liuyongdan/code/fx/git-code/5g-os-server' } },
  },
  {
    spec: {
      id: 'cua', label: 'Cua Driver', transport: 'stdio',
      command: 'C:/Users/liuyd/AppData/Local/Programs/Cua/cua-driver/bin/cua-driver.exe',
      args: ['mcp'],
    },
    probe: { operation: 'list_windows', args: {} },
  },
]

for (const { spec, probe } of providers) {
  const connection = await connectMcpProvider(spec)
  const envelope = await connection.call(probe.operation, probe.args)
  await connection.close()

  const blocks = await toResultBlocks({ providers: () => [], spec: () => undefined }, spec.id, probe.operation, envelope, 'inline')
  const textBlocks = blocks.filter(b => b.kind === 'text')
  const kept = textBlocks.reduce((n, b) => n + (b.kind === 'text' ? b.text.length : 0), 0)
  const ignored = envelope?.structuredContent === undefined
    ? 0
    : JSON.stringify(envelope.structuredContent, null, 2).length
  const rawContent = (Array.isArray(envelope?.content) ? envelope.content : [])
    .filter(b => b?.type === 'text')
    .reduce((n, b) => n + String(b.text ?? '').length, 0)

  console.log(`${spec.label} / ${probe.operation}`)
  console.log(`  text blocks to model : ${textBlocks.length} (was 2 before the fix)`)
  console.log(`  chars kept           : ${kept} (content alone: ${rawContent})`)
  console.log(`  structured ignored   : ${ignored} chars`)
}