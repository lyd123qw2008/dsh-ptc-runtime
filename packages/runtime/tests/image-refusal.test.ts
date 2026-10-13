import { describe, expect, it, vi } from 'vitest'
import { toLosslessJson, toResultBlocks } from '../src/ptc.js'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

const host = { providers: () => [], spec: () => undefined }

describe('a route that refuses images stores nothing', () => {
  it('does not call saveImages when an omission is supplied', async () => {
    // Before the fix the refusal was applied AFTER toResultBlocks ran, so the pixels
    // had already been committed to the durable store — which never prunes them —
    // for a model that could not read them.
    const saved = vi.fn(async () => [{ attachmentId: 'att-1', mediaType: 'image/png', bytes: 68 }])
    const storingHost = { ...host, saveImages: saved }
    const result = {
      content: [
        { type: 'text', text: 'Took a screenshot.' },
        { type: 'image', data: PNG, mimeType: 'image/png' },
      ],
    }
    const blocks = await toResultBlocks(storingHost, 'fx', 'shot', result, 'inline', 'model "m" does not declare image input')
    expect(saved).not.toHaveBeenCalled()
    expect(blocks).toEqual([
      { kind: 'text', text: 'Took a screenshot.' },
      { kind: 'text', text: '[image omitted: model "m" does not declare image input]' },
    ])
  })

  it('still stores images when there is no omission', async () => {
    const saved = vi.fn(async () => [{ attachmentId: 'att-1', mediaType: 'image/png', bytes: 68 }])
    const storingHost = { ...host, saveImages: saved }
    const result = { content: [{ type: 'image', data: PNG, mimeType: 'image/png' }] }
    await toResultBlocks(storingHost, 'fx', 'shot', result, 'inline')
    expect(saved).toHaveBeenCalledTimes(1)
  })

  it('reports the omission for an image admission would refuse too', async () => {
    // The route's refusal is decided before any admission work, so it applies to
    // every image block rather than only the admitted ones.
    const result = { content: [{ type: 'image', data: 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', mimeType: 'image/gif' }] }
    const blocks = await toResultBlocks(host, 'fx', 'shot', result, 'inline', 'text-only route')
    expect(blocks).toEqual([{ kind: 'text', text: '[image omitted: text-only route]' }])
  })
})

describe('a store failure degrades the image, not the call', () => {
  it('keeps the reply text when saveImages throws', async () => {
    // Before the fix the throw escaped toResultBlocks and the whole cap_call failed,
    // discarding the text the model actually needed.
    const failingHost = { ...host, saveImages: async () => { throw new Error('store exploded') } }
    const result = {
      content: [
        { type: 'text', text: 'IMPORTANT TEXT' },
        { type: 'image', data: PNG, mimeType: 'image/png' },
      ],
    }
    const blocks = await toResultBlocks(failingHost, 'fx', 'shot', result, 'inline')
    expect(blocks[0]).toEqual({ kind: 'text', text: 'IMPORTANT TEXT' })
    expect(blocks[1]).toEqual({ kind: 'text', text: '[image omitted: not stored]' })
  })
})

describe('toLosslessJson', () => {
  it('turns non-finite numbers into null instead of failing the run', () => {
    // Reachable from a real MCP reply: `{"n": 1e999}` is valid JSON and parses to Infinity.
    expect(toLosslessJson(JSON.parse('{"n": 1e999}'))).toEqual({ n: null })
    expect(toLosslessJson(JSON.parse('{"n": -1e999}'))).toEqual({ n: null })
  })

  it('drops the sign bit of negative zero', () => {
    const out = toLosslessJson(JSON.parse('{"n": -0}')) as { n: number }
    expect(Object.is(out.n, -0)).toBe(false)
    expect(out.n).toBe(0)
  })

  it('keeps ordinary JSON intact', () => {
    const value = { items: [{ id: 1, name: 'a', ok: true, none: null }], more: false }
    expect(toLosslessJson(value)).toEqual(value)
  })

  it('represents a Date through toJSON and drops a function', () => {
    const out = toLosslessJson({ d: new Date('2020-01-01T00:00:00Z'), f: () => 1 }) as Record<string, unknown>
    expect(out.d).toBe('2020-01-01T00:00:00.000Z')
    expect('f' in out).toBe(false)
  })

  it('breaks cycles instead of recursing forever', () => {
    const cycle: Record<string, unknown> = { keep: 1 }
    cycle.self = cycle
    const out = toLosslessJson(cycle) as Record<string, unknown>
    expect(out.keep).toBe(1)
    expect('self' in out).toBe(false)
  })

  it('fills array holes with null and drops undefined properties', () => {
    const sparse: unknown[] = [1, , 3]
    expect(toLosslessJson(sparse)).toEqual([1, null, 3])
    expect(toLosslessJson({ a: 1, b: undefined })).toEqual({ a: 1 })
  })

  it('produces a value that survives a JSON round trip', () => {
    const hostile = { n: Infinity, z: -0, d: new Date(0), arr: [1, , 3] as unknown[] }
    const normalized = toLosslessJson(hostile)
    expect(JSON.parse(JSON.stringify(normalized))).toEqual(normalized)
  })
})
