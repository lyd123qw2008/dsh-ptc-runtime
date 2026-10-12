/**
 * Why does one `cap_call` come back twice?
 *
 * IDEA's `search_text` sends BOTH `structuredContent` and a text content block
 * holding the same payload. The block mapping pushes both, so the model reads
 * every result twice. This prints the raw envelope so the fix can compare the
 * two forms instead of guessing.
 */

import { connectMcpProvider } from '../packages/runtime/dist/index.js'

const idea = await connectMcpProvider({
  id: 'idea',
  label: 'IntelliJ IDEA',
  transport: 'streamable-http',
  url: 'http://127.0.0.1:64342/stream',
})

const result = await idea.call('search_text', { q: 'package', projectPath: process.argv[2] })
const envelope = result
const content = Array.isArray(envelope?.content) ? envelope.content : []

console.log('structuredContent:', envelope?.structuredContent === undefined ? '<absent>' : 'present')
console.log('content block types:', content.map(b => b?.type).join(', ') || '<none>')

for (const [index, block] of content.entries()) {
  if (block?.type !== 'text') continue
  const text = String(block.text ?? '')
  console.log(`\n--- text block ${index} (${text.length} chars) ---`)
  console.log(text.slice(0, 400))
}

if (envelope?.structuredContent !== undefined) {
  const compact = JSON.stringify(envelope.structuredContent)
  const pretty = JSON.stringify(envelope.structuredContent, null, 2)
  console.log(`\nstructuredContent compact=${compact.length} pretty=${pretty.length}`)
  console.log('compact head:', compact.slice(0, 200))
}

await idea.close()