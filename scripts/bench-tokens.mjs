/**
 * The comparison that motivates this whole package: what does the tool plane cost
 * in model context, versus a direct projection of the same catalog?
 *
 *   node scripts/bench-tokens.mjs
 *
 * Both faces declare their tools on EVERY request, so this is a per-request,
 * per-session cost — the reason a catalog-style face exists at all.
 *
 * The kernel face's number is read from its own source rather than transcribed,
 * so it cannot drift from what that package actually ships.
 */
import { readFileSync } from 'node:fs'
import { createCapTools } from '../packages/adapter-dsh/dist/index.js'

const estimate = value => Math.ceil(JSON.stringify(value).length / 4) + 4

const ptcTools = createCapTools({
  providers: () => [],
  failures: () => [],
  spec: () => undefined,
  refresh: async () => {},
  call: async () => ({ content: [] }),
}).map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters }))

const total = tools => tools.reduce((sum, tool) => sum + estimate(tool), 0)

console.log(`tool declarations (${ptcTools.length} tools)\n`)
console.log('tool'.padEnd(12) + 'tokens'.padStart(9) + 'desc'.padStart(9) + 'params'.padStart(9) + 'desc chars'.padStart(12))
for (const tool of ptcTools) {
  console.log(
    tool.name.padEnd(12)
    + String(estimate(tool)).padStart(9)
    + String(estimate(tool.description)).padStart(9)
    + String(estimate(tool.parameters)).padStart(9)
    + String(tool.description.length).padStart(12),
  )
}
const ptc = total(ptcTools)
console.log(''.padEnd(12) + String(ptc).padStart(9) + '  (total)')

console.log(`\nM1 budget 1200, unit-test assertion 1600`)
console.log(`actual ${ptc} — ${ptc <= 1200 ? 'within M1' : 'OVER M1'}, ${ptc <= 1600 ? 'within test' : 'OVER test'}`)
console.log(`headroom to M1: ${1200 - ptc} tokens`)

// The face must not grow with the catalog.
const wide = createCapTools({
  providers: () => Array.from({ length: 50 }, (_, index) => ({
    id: `provider_${index}`,
    label: `Provider ${index}`,
    operations: Array.from({ length: 100 }, (_unused, op) => ({
      name: `operation_${op}`, summary: 'x', safety: 'read', inputSchema: { type: 'object', properties: {} },
    })),
    call: async () => ({ content: [] }),
    close: async () => {},
  })),
  failures: () => [],
  spec: () => undefined,
  refresh: async () => {},
  call: async () => ({ content: [] }),
}).map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters }))
const wideTotal = total(wide)
console.log(`\nwith 50 providers x 100 operations attached: ${wideTotal} tokens`)
console.log(`growth vs bare: ${wideTotal - ptc} tokens (must be 0 — the face is fixed)`)

// The kernel face, measured from its own source.
console.log('\n--- for reference ---')
const KERNEL = 'D:/liuyongdan/code/node-repl-runtime/packages/adapter-dsh/src/descriptions.ts'
try {
  const source = readFileSync(KERNEL, 'utf8')
  // Rough but source-derived: total quoted-description characters in that file.
  const quoted = [...source.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map(match => match[1]).join(' ')
  const kernelTokens = Math.ceil(quoted.length / 4) + 4
  console.log(`kernel face (js + js_reset), from ${KERNEL.split('/').pop()}: ~${kernelTokens} tokens`)
  console.log(`PTC face is ${(kernelTokens / ptc).toFixed(2)}x the kernel face's description text.`)
} catch (error) {
  console.log(`kernel face: could not read ${KERNEL} (${error.message})`)
}

// A direct projection: one declaration per operation.
console.log('\ndirect projection (one declaration per MCP operation):')
console.log('scenario'.padEnd(34) + 'tokens'.padStart(10) + 'vs PTC'.padStart(10))
for (const [providers, operationsPer] of [[1, 25], [1, 100], [5, 40], [12, 40]]) {
  const tools = []
  for (let provider = 0; provider < providers; provider++) {
    for (let op = 0; op < operationsPer; op++) {
      tools.push({
        name: `mcp__provider_${provider}__operation_${op}`,
        description: `Operation ${op} on provider ${provider}. ${'Detailed server-authored prose about what this operation does. '.repeat(6)}`,
        parameters: {
          type: 'object',
          properties: Object.fromEntries(Array.from({ length: 6 }, (_unused, p) => [
            `param${p}`,
            { type: 'string', description: `Parameter ${p} of this operation, as the server declared it.` },
          ])),
        },
      })
    }
  }
  const direct = total(tools)
  console.log(
    `${providers} provider(s) x ${operationsPer} ops = ${providers * operationsPer}`.padEnd(34)
    + String(direct).padStart(10)
    + `${(direct / ptc).toFixed(1)}x`.padStart(10),
  )
}
console.log('\nThe PTC face is flat: its 2 declarations do not grow with the catalog.')
