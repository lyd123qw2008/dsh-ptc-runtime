/**
 * Does `content` carry everything `structuredContent` does?
 *
 * The design question behind the duplicate: if `structuredContent` is the
 * formatted view of `content`, then rendering `content` alone loses nothing. That
 * is only safe if no server puts data in `structuredContent` that its `content`
 * omits — Cua Driver is the one to check, since it sends prose beside a large
 * structured payload.
 *
 * Usage: node scripts/inspect-payload-pair.mjs [provider]
 */

import { connectMcpProvider } from '../packages/runtime/dist/catalog.js'

const which = process.argv[2] ?? 'cua'

const specs = {
  cua: {
    id: 'cua', label: 'Cua Driver', transport: 'stdio',
    command: 'C:/Users/liuyd/AppData/Local/Programs/Cua/cua-driver/bin/cua-driver.exe',
    args: ['mcp'],
  },
  idea: {
    id: 'idea', label: 'IntelliJ IDEA', transport: 'streamable-http',
    url: 'http://127.0.0.1:64342/stream',
  },
}

const probe = {
  cua: { operation: 'list_windows', args: {} },
  idea: { operation: 'get_project_modules', args: { projectPath: 'D:/liuyongdan/code/fx/git-code/5g-os-server' } },
}

const spec = specs[which]
if (spec === undefined) throw new Error(`unknown provider: ${which}`)

const connection = await connectMcpProvider(spec)
const result = await connection.call(probe[which].operation, probe[which].args)
await connection.close()

const content = Array.isArray(result?.content) ? result.content : []
const texts = content.filter(b => b?.type === 'text').map(b => String(b.text ?? ''))
const structured = result?.structuredContent

console.log(`=== ${spec.label} / ${probe[which].operation} ===`)
console.log(`content text blocks : ${texts.length} (${texts.join('').length} chars)`)
console.log(`structuredContent   : ${structured === undefined ? 'ABSENT' : `${JSON.stringify(structured, null, 2).length} chars`}`)
console.log('\n--- FULL content text ---')
console.log(texts.join('\n'))
if (structured !== undefined) {
  console.log('\n--- FULL structuredContent (first 3000) ---')
  console.log(JSON.stringify(structured, null, 2).slice(0, 3000))
  // The decisive test: do the structured payload's identifiers appear in the prose?
  const prose = texts.join('\n')
  const flat = JSON.stringify(structured)
  const names = [...new Set((flat.match(/"(?:title|name|path|url)":"[^"]{2,60}"/g) ?? []).map(s => s.slice(s.indexOf(':') + 2, -1)))]
  const missing = names.filter(n => !prose.includes(n))
  console.log(`\nidentifiers in structured: ${names.length}, absent from prose: ${missing.length}`)
  if (missing.length > 0) console.log('MISSING FROM PROSE:', missing.slice(0, 10).join(' | '))
}