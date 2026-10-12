/**
 * Why does the ptc-cap profile take minutes to listen?
 *
 * Isolates the three candidate stalls without starting DSH:
 *   1. the PTC runtime attaching all six providers from the real patch config,
 *   2. `tools/list` against the IDE endpoint alone,
 *   3. the same providers with the ones most likely to block removed.
 *
 * Usage: node scripts/diagnose-startup.mjs [--full]
 */

import { readFileSync } from 'node:fs'
import { createCapabilityRuntime, describeProviders } from '../packages/runtime/dist/index.js'

const PATCH = 'D:/liuyongdan/code/deepseek-harness-data-upgrade-0.2.1-alpha.1/profiles/ptc-cap/cordis.patch.yml'

/** Crude but sufficient: pull the provider blocks out of the patch as raw text. */
function providersFromPatch(text) {
  const start = text.indexOf('providers:')
  if (start === -1) return []
  const lines = text.slice(start).split('\n')
  const specs = []
  let current = null
  let depth = 0
  for (const line of lines) {
    const item = line.match(/^\s{10}- id: (\S+)/)
    if (item !== null) {
      if (current !== null) specs.push(current)
      current = { id: item[1], _lines: [] }
      continue
    }
    if (current === null) break
    if (/^\s{4}- id: /.test(line)) break
    current._lines.push(line)
  }
  if (current !== null) specs.push(current)
  return specs.map(spec => ({ id: spec.id, raw: spec._lines.join('\n') }))
}

const full = process.argv.includes('--full')
const started = Date.now()
const mark = label => console.log(`[${String(Date.now() - started).padStart(6)}ms] ${label}`)

mark('patch read start')
const patch = readFileSync(PATCH, 'utf8')
const found = providersFromPatch(patch)
mark(`patch read done: ${found.length} provider blocks -> ${found.map(p => p.id).join(', ')}`)

for (const provider of found) {
  const disabled = /disabled:\s*true/.test(provider.raw)
  console.log(`  ${provider.id}: ${disabled ? 'DISABLED' : 'enabled'} (${provider.raw.split('\n').filter(l => l.trim()).length} lines)`)
}

if (!full) {
  console.log('\nRe-run with --full to actually attach providers (this spawns real MCP children).')
  process.exit(0)
}

// Attach the two HTTP/quick ones first to see whether the stall is a provider.
const quick = [
  { id: 'idea', label: 'IntelliJ IDEA', transport: 'streamable-http', url: 'http://127.0.0.1:64342/stream' },
]
mark('attaching idea only')
const runtime = await createCapabilityRuntime({ providers: quick })
mark(`idea done: ${describeProviders(runtime.catalog(), runtime.failures())}`)
await runtime.dispose()
mark('disposed')