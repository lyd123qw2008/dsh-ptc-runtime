import { describe, expect, it } from 'vitest'
import { toLosslessJson } from '../src/ptc.js'

describe('toLosslessJson copy-on-write', () => {
  it('returns the SAME object when nothing needs changing', () => {
    // The common case: a reply that came through JSON.parse is already lossless, so
    // rebuilding an identical graph was pure cost.
    const value = { items: [{ id: 1, name: 'a' }], more: true }
    expect(toLosslessJson(value)).toBe(value)
  })

  it('returns the same nested containers too, not just the root', () => {
    const inner = { id: 1 }
    const value = { items: [inner] }
    const out = toLosslessJson(value) as typeof value
    expect(out).toBe(value)
    expect(out.items[0]).toBe(inner)
  })

  it('copies when a non-finite number must become null', () => {
    const value = JSON.parse('{"n": 1e999, "keep": {"a": 1}}')
    const out = toLosslessJson(value) as { n: unknown; keep: unknown }
    expect(out).not.toBe(value)
    expect(out.n).toBeNull()
    // An untouched branch is shared, not deep-copied.
    expect(out.keep).toBe(value.keep)
  })

  it('copies when negative zero must lose its sign', () => {
    const value = JSON.parse('{"n": -0}')
    const out = toLosslessJson(value) as { n: number }
    expect(out).not.toBe(value)
    expect(Object.is(out.n, -0)).toBe(false)
    expect(out.n).toBe(0)
  })

  it('copies when an undefined property must be dropped', () => {
    const value: Record<string, unknown> = { a: 1, b: undefined }
    const out = toLosslessJson(value) as Record<string, unknown>
    expect(out).not.toBe(value)
    expect(out).toEqual({ a: 1 })
    expect('b' in out).toBe(false)
  })

  it('copies when an array hole must become null', () => {
    const value: unknown[] = [1, , 3]
    const out = toLosslessJson(value) as unknown[]
    expect(out).not.toBe(value)
    expect(out).toEqual([1, null, 3])
  })

  it('copies when a function must be dropped', () => {
    const value = { keep: 1, f: () => 1 }
    const out = toLosslessJson(value) as Record<string, unknown>
    expect(out).not.toBe(value)
    expect(out.keep).toBe(1)
    expect('f' in out).toBe(false)
  })

  it('represents a Date through toJSON even though it needs a copy', () => {
    const value = { d: new Date('2020-01-01T00:00:00Z') }
    const out = toLosslessJson(value) as Record<string, unknown>
    expect(out.d).toBe('2020-01-01T00:00:00.000Z')
  })

  it('drops a cycle rather than recursing forever', () => {
    const cycle: Record<string, unknown> = { keep: 1 }
    cycle.self = cycle
    const out = toLosslessJson(cycle) as Record<string, unknown>
    expect(out.keep).toBe(1)
    expect('self' in out).toBe(false)
  })

  it('does not mistake a shared sibling for a cycle', () => {
    // The ancestors set tracks the current PATH only: the same object appearing
    // twice as a sibling is legal JSON, and must survive.
    const shared = { id: 1 }
    const value = { a: shared, b: shared }
    const out = toLosslessJson(value) as { a: unknown; b: unknown }
    expect(out).toBe(value)
    expect(out.a).toBe(shared)
    expect(out.b).toBe(shared)
  })

  it('still normalizes a shared sibling that needs work, without false-cycling', () => {
    const shared = JSON.parse('{"n": 1e999}')
    const value = { a: shared, b: shared }
    const out = toLosslessJson(value) as { a: { n: unknown }; b: { n: unknown } }
    expect(out).not.toBe(value)
    expect(out.a.n).toBeNull()
    expect(out.b.n).toBeNull()
  })

  it('preserves an explicit null root', () => {
    expect(toLosslessJson(null)).toBeNull()
  })

  it('returns undefined for values JSON cannot carry at all', () => {
    expect(toLosslessJson(undefined)).toBeUndefined()
    expect(toLosslessJson(() => 1)).toBeUndefined()
    expect(toLosslessJson(Symbol('x'))).toBeUndefined()
    expect(toLosslessJson(1n)).toBeUndefined()
  })

  it('produces a value that survives a JSON round trip', () => {
    const hostile = { n: Infinity, z: -0, d: new Date(0), arr: [1, , 3] as unknown[] }
    const normalized = toLosslessJson(hostile)
    expect(JSON.parse(JSON.stringify(normalized))).toEqual(normalized)
  })

  it('leaves a large clean payload identical (the hot path)', () => {
    const items = Array.from({ length: 2000 }, (_, index) => ({ id: index, name: `item-${index}` }))
    const value = { items, total: items.length }
    expect(toLosslessJson(value)).toBe(value)
  })
})
