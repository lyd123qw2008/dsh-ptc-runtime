/**
 * Does the `data` field this face now attaches survive DSH's own lossless-JSON
 * gate? A `run_code` completion is validated by `snapshotPtcJsonValue`
 * (ptc-runtime-node `bootstrap.ts` `prepareCompletion`), so a value this face
 * produces can fail the run with `invalid-output: program completion must be
 * lossless JSON`. This probe runs DSH's shipped validator — not a copy of the
 * rules — over the real envelope from each provider.
 *
 *   node probe-lossless.mjs
 */
import { connectMcpProvider, providerStructuredContent, toResultBlocks } from './dist/index.js'
import { isJsonValue } from 'file:///D:/liuyongdan/code/deepseek-harness-upgrade-0.2.1-alpha.1/packages/util/values/lib/index.js'

/** First path that lossless JSON cannot represent, or undefined when the value is fine. */
function findLossy(value, path = '$', ancestors = new Set()) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return undefined
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return `${path} = ${String(value)} (non-finite)`
    if (Object.is(value, -0)) return `${path} = -0 (sign bit is lossy)`
    return undefined
  }
  if (typeof value !== 'object') return `${path} = ${typeof value}`
  if (ancestors.has(value)) return `${path} (cycle)`
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== Array.prototype && proto !== null) {
    return `${path} (prototype ${proto?.constructor?.name ?? 'null'})`
  }
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, i)) return `${path}[${i}] (sparse)`
        const hit = findLossy(value[i], `${path}[${i}]`, ancestors)
        if (hit !== undefined) return hit
      }
      return undefined
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return `${path} (symbol key)`
      if (!Object.prototype.propertyIsEnumerable.call(value, key)) return `${path}.${key} (non-enumerable)`
      const hit = findLossy(value[key], `${path}.${key}`, ancestors)
      if (hit !== undefined) return hit
    }
    return undefined
  } finally {
    ancestors.delete(value)
  }
}

const CASES = [
  {
    spec: {
      id: 'cua', label: 'Cua Driver desktop', transport: 'stdio',
      command: 'C:/Users/liuyd/AppData/Local/Programs/Cua/cua-driver/bin/cua-driver.exe',
      args: ['mcp'],
    },
    operation: 'list_windows', args: {},
  },
  {
    spec: {
      id: 'idea', label: 'IntelliJ IDEA', transport: 'streamable-http',
      url: 'http://127.0.0.1:64342/stream',
      inject: { projectPath: 'D:/liuyongdan/code/fx/git-code/5g-os-server' },
    },
    operation: 'search_text', args: { q: 'RcsH5LabelDbService' },
  },
]

for (const testCase of CASES) {
  const connection = await connectMcpProvider(testCase.spec)
  try {
    const envelope = await connection.call(testCase.operation, testCase.args)
    const data = providerStructuredContent(envelope)
    const blocks = await toResultBlocks({ providers: () => [connection] }, testCase.spec.id, testCase.operation, envelope, 'inline')
    const value = { provider: testCase.spec.id, operation: testCase.operation, blocks, ...data === undefined ? {} : { data } }

    const dataOk = data === undefined ? 'absent' : String(isJsonValue(data))
    console.log(`${testCase.spec.id}.${testCase.operation}`)
    console.log(`  data:  ${dataOk}${data === undefined ? '' : `  chars=${JSON.stringify(data).length}`}`)
    console.log(`  value: ${isJsonValue(value)}`)
    if (data !== undefined && !isJsonValue(data)) console.log(`  first lossy in data:  ${findLossy(data)}`)
    if (!isJsonValue(value)) console.log(`  first lossy in value: ${findLossy(value)}`)
  } catch (error) {
    console.log(`${testCase.spec.id}.${testCase.operation} FAILED: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    await connection.close()
  }
}
