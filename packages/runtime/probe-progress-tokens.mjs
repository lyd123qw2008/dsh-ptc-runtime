/**
 * What progress tokens does the IDEA MCP server actually use?
 *
 * The SDK registers `progressToken = <its own request id>` and errors on any
 * notification whose token is not in its handler table. The 2026-10-12 report was
 * `progressToken: 6` against an unknown token — which suggests the server either
 * reuses expired tokens or numbers its own sequence.
 *
 * This logs every notification the server sends, in order, across a real call,
 * and prints the tokens the SDK registered for that call.
 */

import { Client } from '@modelcontextprotocol/client'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client'

const URL = 'http://127.0.0.1:64342/stream'

const transport = new StreamableHTTPClientTransport(new URL(URL))
const seen = []

// Wrap the transport so every inbound notification is visible before the SDK's
// handler decides it is an error.
const originalOnMessage = transport.onmessage?.bind(transport)
transport.onmessage = (message, ...rest) => {
  if (message !== undefined && typeof message === 'object' && message.method === 'notifications/progress') {
    seen.push({
      token: message.params?.progressToken,
      progress: message.params?.progress,
      total: message.params?.total,
      message: message.params?.message,
    })
  }
  return originalOnMessage?.(message, ...rest)
}

const client = new Client({ name: 'ptc-token-probe', version: '0.0.0' }, { capabilities: {} })
await client.connect(transport)

// The registered tokens are private; infer them from the counter by watching
// which ids the SDK uses as JSON-RPC ids.
const ids = []
const originalSend = transport.send?.bind(transport)
transport.send = (message, ...rest) => {
  if (message !== undefined && typeof message === 'object' && typeof message.id === 'number') {
    ids.push({ id: message.id, method: message.method, token: message.params?._meta?.progressToken })
  }
  return originalSend?.(message, ...rest)
}

console.log('--- tools/list (no onprogress => no token registered) ---')
await client.listTools(undefined, { timeout: 60_000 })

console.log('--- search_text (with onprogress) ---')
seen.length = 0
try {
  const result = await client.callTool(
    { name: 'search_text', arguments: { q: 'package', projectPath: 'D:/liuyongdan/code/fx/git-code/5g-os-server' } },
    { onprogress: () => {}, resetTimeoutOnProgress: true, timeout: 120_000 },
  )
  console.log('call ok, content blocks:', Array.isArray(result.content) ? result.content.length : 0)
} catch (error) {
  console.log('call failed:', error instanceof Error ? error.message.split('\n')[0] : String(error))
}

console.log('\n--- JSON-RPC ids the client sent ---')
for (const entry of ids) console.log(`  id=${entry.id} method=${entry.method} progressToken=${entry.token ?? '<none>'}`)

console.log('\n--- progress notifications the server sent ---')
for (const entry of seen) {
  console.log(`  token=${entry.token} progress=${entry.progress}/${entry.total ?? '?'} msg=${JSON.stringify(String(entry.message ?? '').slice(0, 80))}`)
}

const registered = new Set(ids.filter(e => e.token !== undefined).map(e => String(e.token)))
const unknown = seen.filter(e => !registered.has(String(e.token)))
console.log(`\nSDK-registered tokens: [${[...registered].join(', ')}]`)
console.log(`server-sent tokens:    [${[...new Set(seen.map(e => String(e.token)))].join(', ')}]`)
console.log(`unknown-token notifications: ${unknown.length}/${seen.length}`)

await client.close()