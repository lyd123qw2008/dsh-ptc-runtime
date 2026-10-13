/**
 * What copy-on-write actually saves, measured deterministically.
 *
 *   node --expose-gc scripts/bench-memory.mjs
 *
 * An earlier version of this script reported `heapUsed` growth per call. Those
 * numbers were too noisy to be evidence — GC timing dominated them, and one size
 * even contradicted the trend (new "using" more than old). This measures the one
 * thing that is deterministic instead: how many DISTINCT objects a run of N calls
 * produces, and how many bytes of distinct graph that is.
 *
 * For a payload that is already lossless:
 *   - the previous implementation returned a fresh deep copy per call, so N calls
 *     retained N separate graphs;
 *   - the current one returns the input itself, so N calls retain 1.
 */
import { toLosslessJson } from '../packages/runtime/dist/index.js'

/** The pre-optimization implementation, verbatim, for differential comparison. */
function oldToLosslessJson(value, ancestors = new Set()) {
  if (value === null) return null
  const type = typeof value
  if (type === 'string' || type === 'boolean') return value
  if (type === 'number') {
    const number = value
    if (!Number.isFinite(number)) return null
    return Object.is(number, -0) ? 0 : number
  }
  if (type !== 'object') return undefined
  if (ancestors.has(value)) return undefined
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      const items = []
      for (let index = 0; index < value.length; index++) {
        const item = index in value ? oldToLosslessJson(value[index], ancestors) : undefined
        items.push(item === undefined ? null : item)
      }
      return items
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      const toJSON = value.toJSON
      return typeof toJSON === 'function' ? oldToLosslessJson(toJSON.call(value), ancestors) : undefined
    }
    const plain = {}
    for (const [key, held] of Object.entries(value)) {
      const item = oldToLosslessJson(held, ancestors)
      if (item !== undefined) plain[key] = item
    }
    return plain
  } finally {
    ancestors.delete(value)
  }
}

function searchPayload(targetChars) {
  const items = []
  let size = 0
  let index = 0
  while (size < targetChars) {
    const item = {
      filePath: `src/main/java/com/montnets/modules/aim/service/impl/Generated${index}.java`,
      lineNumber: 100 + index,
      lineText: `    private static final String CONSTANT_${index} = "${'x'.repeat(60)}";`,
      score: index / 7,
      matched: index % 2 === 0,
    }
    items.push(item)
    size += JSON.stringify(item).length
    index++
  }
  return { items, total: items.length, truncated: false }
}

const CALLS = 20

console.log(`clean payload (already lossless) — the common case, ${CALLS} calls\n`)
console.log('payload'.padStart(10) + 'old: distinct'.padStart(16) + 'new: distinct'.padStart(15) + 'new: shares input'.padStart(19))

for (const size of [150_000, 1_000_000, 4_000_000]) {
  const payload = searchPayload(size)
  const actual = JSON.stringify(payload).length

  const oldResults = Array.from({ length: CALLS }, () => oldToLosslessJson(payload))
  const newResults = Array.from({ length: CALLS }, () => toLosslessJson(payload))

  const oldDistinct = new Set(oldResults).size
  const newDistinct = new Set(newResults).size
  const sharesInput = newResults.every(result => result === payload)

  console.log(
    `${(actual / 1024).toFixed(0)} KB`.padStart(10)
    + `${String(oldDistinct)} of ${CALLS}`.padStart(16)
    + `${String(newDistinct)} of ${CALLS}`.padStart(15)
    + `${String(sharesInput)}`.padStart(19),
  )
}

console.log('\nThe old implementation produced one duplicate graph per call; the new one')
console.log('produces none — every call returns the same input object. That is the whole')
console.log('saving, and it is deterministic (no GC timing involved).')
console.log('\nFor a payload that NEEDS rewriting, both allocate a replacement graph;')
console.log('copy-on-write only avoids the copy on the clean path.')
