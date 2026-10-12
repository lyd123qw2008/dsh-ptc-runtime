/**
 * Is the duplicate payload an IDEA quirk or a general MCP pattern?
 *
 * For each provider, calls a read-only operation and reports whether the reply
 * carries `structuredContent`, how many text blocks, and whether each text block
 * is a JSON object (a data copy) or prose (a human-readable note).
 *
 * The distinction decides the fix's basis: dropping by CONTENT EQUALITY is a
 * guess about one server; dropping by BLOCK KIND is a rule about the protocol.
 *
 * Usage: node scripts/survey-duplicates.mjs
 */

import { connectMcpProvider } from '../packages/runtime/dist/catalog.js'

const providers = [
  { id: 'idea', label: 'IntelliJ IDEA', transport: 'streamable-http', url: 'http://127.0.0.1:64342/stream' },
  {
    id: 'playwright',
    label: 'Playwright',
    transport: 'stdio',
    command: process.execPath,
    args: [
      'D:/liuyongdan/code/deepseek-harness-data-upgrade-0.2.1-alpha.1/profiles/ptc-cap/node_modules/@playwright/mcp/cli.js',
      '--extension', '--browser', 'msedge',
    ],
    cwd: 'D:/liuyongdan/code/deepseek-harness-data-upgrade-0.2.1-alpha.1/profiles/ptc-cap',
    env: { PLAYWRIGHT_MCP_EXTENSION_TOKEN: process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN ?? '' },
  },
  {
    id: 'cua',
    label: 'Cua Driver',
    transport: 'stdio',
    command: 'C:/Users/liuyd/AppData/Local/Programs/Cua/cua-driver/bin/cua-driver.exe',
    args: ['mcp'],
  },
  {
    id: 'cheatengine',
    label: 'Cheat Engine',
    transport: 'stdio',
    command: 'D:/liuyongdan/code/cheatengine-mcp-bridge/.venv/Scripts/python.exe',
    args: ['D:/liuyongdan/code/cheatengine-mcp-bridge/MCP_Server/mcp_cheatengine.py'],
    cwd: 'D:/liuyongdan/code/cheatengine-mcp-bridge/MCP_Server',
  },
  {
    id: 'engram',
    label: 'Engram',
    transport: 'stdio',
    command: 'D:/liuyongdan/code/deepseek-harness-data-upgrade-0.2.1-alpha.1/tools/engram/v1.20.0/engram.exe',
    args: ['mcp'],
    cwd: 'D:/liuyongdan/code/deepseek-harness-data-upgrade-0.2.1-alpha.1',
    env: { ENGRAM_DATA_DIR: 'D:/liuyongdan/code/deepseek-harness-data-upgrade-0.2.1-alpha.1/storages/engram', ENGRAM_PROJECT: 'dsh-global' },
  },
]

/** Read-only operation per provider, so the survey never mutates anything. */
const probe = {
  idea: { operation: 'get_project_modules', args: { projectPath: 'D:/liuyongdan/code/fx/git-code/5g-os-server' } },
  playwright: { operation: 'browser_tabs', args: { action: 'list' } },
  cua: { operation: 'list_windows', args: {} },
  cheatengine: { operation: 'get_status', args: {} },
  engram: { operation: 'mem_context', args: { query: 'ptc' } },
}

const looksJson = (text) => {
  const trimmed = String(text ?? '').trim()
  return trimmed.startsWith('{') || trimmed.startsWith('[')
}

for (const spec of providers) {
  const target = probe[spec.id]
  process.stdout.write(`\n=== ${spec.label} ===\n`)
  let connection
  try {
    connection = await connectMcpProvider(spec)
    if (target === undefined) {
      console.log('no probe defined')
      continue
    }
    const result = await connection.call(target.operation, target.args)
    const hasStructured = result?.structuredContent !== undefined
    const content = Array.isArray(result?.content) ? result.content : []
    const texts = content.filter(b => b?.type === 'text')
    console.log(`structuredContent: ${hasStructured ? 'present' : 'ABSENT'}`)
    console.log(`content blocks: ${content.length} (text=${texts.length}, image=${content.filter(b => b?.type === 'image').length})`)
    for (const [i, block] of texts.entries()) {
      const t = String(block.text ?? '')
      console.log(`  text[${i}] ${t.length} chars, ${looksJson(t) ? 'JSON-shaped' : 'PROSE'}`)
    }
    if (hasStructured) {
      const s = JSON.stringify(result.structuredContent, null, 2)
      console.log(`  structured pretty=${s.length} chars`)
      const match = texts.find(b => {
        try { return JSON.stringify(JSON.parse(String(b.text ?? '').trim())) === JSON.stringify(result.structuredContent) } catch { return false }
      })
      console.log(`  a text block byte-matches structuredContent: ${match !== undefined}`)
    }
  } catch (error) {
    console.log(`ERROR: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
  } finally {
    await connection?.close().catch(() => {})
  }
}