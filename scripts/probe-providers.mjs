/**
 * Independent probe: attach the same providers the profile uses and report their
 * operation counts. This proves the catalog path without driving a browser or
 * touching the shared kernel — the verification route available when another
 * session owns the node_repl kernel.
 *
 *   node packages/runtime/dist/cli.js --id idea --url http://127.0.0.1:64342/stream
 */

import { createCapabilityRuntime, describeProviders } from '../packages/runtime/dist/index.js'

/** @type {import('../packages/runtime/dist/types.js').McpProviderSpec[]} */
const specs = [
  { id: 'idea', label: 'IntelliJ IDEA', transport: 'streamable-http', url: 'http://127.0.0.1:64342/stream' },
  {
    id: 'playwright',
    label: 'Playwright (Edge extension)',
    transport: 'stdio',
    command: process.execPath,
    args: [
      'D:/liuyongdan/code/deepseek-harness-data-upgrade-0.2.1-alpha.2/profiles/web/node_modules/@playwright/mcp/cli.js',
      '--extension', '--browser', 'msedge', '--file-paths', 'absolute',
    ],
    cwd: 'D:/liuyongdan/code/deepseek-harness-data-upgrade-0.2.1-alpha.2/profiles/web',
    env: { PLAYWRIGHT_MCP_EXTENSION_TOKEN: process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN ?? '' },
  },
  {
    id: 'cua',
    label: 'Cua Driver desktop',
    transport: 'stdio',
    command: 'C:/Users/liuyd/AppData/Local/Programs/Cua/cua-driver/bin/cua-driver.exe',
    args: ['mcp'],
  },
]

const runtime = await createCapabilityRuntime({ providers: specs })
console.log(describeProviders(runtime.catalog(), runtime.failures()))

const idea = runtime.catalog().find(p => p.id === 'idea')
if (idea !== undefined) {
  const started = Date.now()
  const result = await runtime.runProgram({
    calls: [{ target: 'idea.search_text', title: 'probe', args: { q: 'PtcRuntime' } }],
  })
  console.log(`\nidea.search_text -> ok=${result.ok} ${result.durationMs}ms (wall ${Date.now() - started}ms)`)
  console.log(result.calls[0]?.error ?? result.calls[0]?.blocks.map(b => b.kind === 'text' ? b.text.slice(0, 300) : `[${b.kind}]`).join('\n'))
}

await runtime.dispose()