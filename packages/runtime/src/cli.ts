/**
 * `integration:demo` — attach one MCP server and run one batched program.
 *
 *   node packages/runtime/dist/cli.js \
 *     --id idea \
 *     --url http://127.0.0.1:64342/stream \
 *     --inject projectPath=D:/path/to/project \
 *     --target idea.search_text --args '{"q":"class"}'
 */

import { readFileSync } from 'node:fs'
import { createCapabilityRuntime } from './index.js'
import type { McpProviderSpec } from './types.js'

function parse(argv: readonly string[]): { spec: McpProviderSpec; target: string; args: Record<string, unknown>; timeoutMs: number } {
  const values = new Map<string, string[]>()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!
    if (!token.startsWith('--')) continue
    const next = argv[index + 1]
    const list = values.get(token.slice(2)) ?? []
    if (next !== undefined && !next.startsWith('--')) {
      list.push(next)
      index += 1
    }
    values.set(token.slice(2), list)
  }
  const id = values.get('id')?.[0]
  if (id === undefined) throw new Error('--id is required')
  const url = values.get('url')?.[0]
  const command = values.get('command')?.[0]
  if (url === undefined && command === undefined) throw new Error('--url (http) or --command (stdio) is required')
  const inject: Record<string, string> = {}
  for (const text of values.get('inject') ?? []) {
    const separator = text.indexOf('=')
    if (separator <= 0) throw new Error(`--inject expects name=value, got ${text}`)
    inject[text.slice(0, separator)] = text.slice(separator + 1)
  }
  const target = values.get('target')?.[0] ?? ''
  const argsText = values.get('args')?.[0]
  return {
    spec: {
      id,
      label: values.get('label')?.[0] ?? id,
      transport: url === undefined ? 'stdio' : 'streamable-http',
      ...url === undefined ? {} : { url },
      ...command === undefined ? {} : { command },
      ...Object.keys(inject).length === 0 ? {} : { inject },
    },
    target,
    args: argsText === undefined ? {} : JSON.parse(argsText) as Record<string, unknown>,
    timeoutMs: Number(values.get('timeout')?.[0] ?? 60_000),
  }
}

const parsed = parse(process.argv.slice(2))
const runtime = await createCapabilityRuntime({ providers: [parsed.spec] })

try {
  for (const provider of runtime.catalog()) {
    console.log(`provider ${provider.id} (${provider.label}) — ${provider.operations.length} operation(s)`)
  }
  if (parsed.target !== '') {
    const result = await runtime.runProgram({ calls: [{ target: parsed.target, args: parsed.args }] })
    console.log(`\nprogram ok: ${result.ok} (${result.durationMs}ms)`)
    for (const call of result.calls) {
      for (const block of call.blocks) {
        if (block.kind === 'text') console.log(block.text)
        else if (block.kind === 'image-meta') console.log(`[image: ${block.mimeType} ${block.bytes} bytes sha ${block.hash}]`)
        else console.log(`[image attachment: ${block.attachment.attachmentId}]`)
      }
      if (call.error !== undefined) console.log(`error: ${call.error}`)
    }
    if (!result.ok) process.exitCode = 1
  } else {
    void readFileSync
    console.log('no --target given; catalog printed above')
  }
} finally {
  await runtime.dispose()
}
