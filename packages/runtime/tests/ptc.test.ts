import { describe, expect, it, vi } from 'vitest'
import { runDirect, buildProgram, splitTarget, splitBatchTarget, MAX_BATCH_TARGETS } from '../src/ptc.js'
import type { ProviderConnection } from '../src/types.js'

function fakeConnection(overrides: Partial<ProviderConnection> = {}): ProviderConnection {
  return {
    id: 'fx',
    label: 'fixture',
    operations: [
      { name: 'ping', summary: 'Return a small value.', safety: 'read', inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false } },
      { name: 'push', summary: 'Mutate something.', safety: 'mutate', inputSchema: { type: 'object', properties: { tag: { type: 'string' } }, required: ['tag'], additionalProperties: false } },
    ],
    call: vi.fn(async () => ({ content: [{ type: 'text', text: 'pong' }] })),
    close: vi.fn(async () => {}),
    ...overrides,
  }
}

const hostOf = (connection: ProviderConnection) => ({
  providers: () => [connection],
  spec: (id: string) => (id === 'fx' ? { id: 'fx', transport: 'stdio' as const, command: 'node', inject: { projectPath: 'D:/proj' } } : undefined),
})

describe('splitTarget', () => {
  it('splits at the first dot', () => {
    expect(splitTarget('fx.push')).toEqual({ provider: 'fx', operation: 'push' })
    expect(splitTarget('a.b.c')).toEqual({ provider: 'a', operation: 'b.c' })
    expect(splitTarget('fx')).toEqual({ provider: 'fx' })
    expect(splitTarget('')).toEqual({ provider: '' })
  })
})

describe('splitBatchTarget', () => {
  it('splits comma batches and caps at 8', () => {
    expect(splitBatchTarget('fx.ping, fx.push')).toEqual(['fx.ping', 'fx.push'])
    expect(() => splitBatchTarget(Array.from({ length: MAX_BATCH_TARGETS + 1 }, (_, i) => `fx.op${i}`).join(','))).toThrow(/at most 8/)
  })
})

describe('runDirect', () => {
  it('runs calls in order and records each', async () => {
    const connection = fakeConnection()
    const result = await runDirect(hostOf(connection), { calls: [{ target: 'fx.ping', title: '探活' }, { target: 'fx.push', args: { tag: 't' } }] })
    expect(result.ok).toBe(true)
    expect(result.calls).toHaveLength(2)
    expect(result.calls[0]!.title).toBe('探活')
    expect(connection.call).toHaveBeenCalledTimes(2)
  })

  it('stops at the first failure with the error recorded', async () => {
    const connection = fakeConnection({ call: vi.fn(async () => ({ isError: true, content: [{ type: 'text', text: 'boom' }] })) })
    const result = await runDirect(hostOf(connection), { calls: [{ target: 'fx.ping' }] })
    expect(result.ok).toBe(false)
    expect(result.calls[0]!.ok).toBe(false)
    expect(result.error).toContain('boom')
  })

  it('names available operations on unknown operation', async () => {
    const connection = fakeConnection()
    const result = await runDirect(hostOf(connection), { calls: [{ target: 'fx.nope' }] })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('available: ping, push')
  })

  it('refuses host-owned args', async () => {
    const connection = fakeConnection()
    const call = connection.call as ReturnType<typeof vi.fn>
    const result = await runDirect(hostOf(connection), { calls: [{ target: 'fx.ping', args: { projectPath: 'D:/elsewhere' } }] })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('host-owned')
    expect(call).not.toHaveBeenCalled()
  })

  it('passes args on verbatim, leaving injection to the connection', async () => {
    // The connection owns injection and refuses a caller-supplied host-owned key,
    // so merging `spec.inject` here as well made EVERY injected provider fail with
    // "may not be supplied by the caller". node-repl-runtime's bridge passes args
    // unchanged (`bridge.ts:214`), which is why the kernel never had this.
    // `hostOf` declares `inject: { projectPath: 'D:/proj' }`, so a merge would show.
    const seen: Record<string, unknown>[] = []
    const connection = fakeConnection({
      call: vi.fn(async (_operation: string, args: Record<string, unknown>) => {
        seen.push(args)
        return { content: [{ type: 'text', text: 'pong' }] }
      }),
    })
    const result = await runDirect(hostOf(connection), { calls: [{ target: 'fx.ping' }] })
    expect(result.ok).toBe(true)
    expect(seen[0]).toEqual({})
    expect('projectPath' in (seen[0] ?? {})).toBe(false)
  })

  it('returns metadata-only images without delivering pixels', async () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
    const connection = fakeConnection({
      call: vi.fn(async () => ({ content: [{ type: 'image', data: png, mimeType: 'image/png' }] })),
    })
    const result = await runDirect(hostOf(connection), { calls: [{ target: 'fx.ping', deliver: 'metadata-only' }] })
    expect(result.ok).toBe(true)
    const block = result.calls[0]!.blocks[0]!
    expect(block.kind).toBe('image-meta')
    if (block.kind === 'image-meta') {
      expect(block.mimeType).toBe('image/png')
      expect(block.bytes).toBeGreaterThan(0)
      expect(block.hash).toHaveLength(16)
    }
  })
})

describe('the content channel only', () => {
  // `CallToolResultSchema` makes `content` the guaranteed field and
  // `structuredContent` the optional one, so `content` alone is what the model
  // reads. IDEA sends the SAME value in both (150,565 chars each on
  // `search_text`, 2026-10-12) — reading both wasted 43% of the reply.
  const PAYLOAD = { items: [{ filePath: 'A.java', startLine: 1 }], more: true }

  it('renders content and ignores a duplicated structuredContent', async () => {
    const connection = fakeConnection({
      call: vi.fn(async () => ({
        structuredContent: PAYLOAD,
        content: [{ type: 'text', text: JSON.stringify(PAYLOAD) }],
      })),
    })
    const result = await runDirect(hostOf(connection), { calls: [{ target: 'fx.ping' }] })
    const texts = result.calls[0]!.blocks.filter(b => b.kind === 'text')
    expect(texts).toHaveLength(1)
    expect(JSON.parse(texts[0]!.kind === 'text' ? texts[0]!.text : '')).toEqual(PAYLOAD)
  })

  it('renders content prose even when structuredContent holds more', async () => {
    // Cua Driver's shape: the prose announces its own omissions and the
    // structured payload holds the rest. The prose is what the MODEL reads, so
    // `blocks` carries it; the payload is not lost — it rides on `data` for the
    // program. Rendering both here is what produced the duplicated reply this
    // face exists to remove, so the model-facing side stays content-only.
    const connection = fakeConnection({
      call: vi.fn(async () => ({
        structuredContent: { windows: [{ x: 0, y: 0, height: 1, width: 1 }] },
        content: [{ type: 'text', text: 'Found 23 window(s) across 17 app(s).' }],
      })),
    })
    const result = await runDirect(hostOf(connection), { calls: [{ target: 'fx.ping' }] })
    const texts = result.calls[0]!.blocks.filter(b => b.kind === 'text')
    expect(texts).toHaveLength(1)
    expect(texts[0]!.kind === 'text' ? texts[0]!.text : '').toBe('Found 23 window(s) across 17 app(s).')
    expect(result.calls[0]!.data).toEqual({ windows: [{ x: 0, y: 0, height: 1, width: 1 }] })
  })

  it('falls back to structuredContent when content is empty', async () => {
    // A schema-only server may send no blocks at all; rendering nothing would
    // hide a real result.
    const connection = fakeConnection({
      call: vi.fn(async () => ({ structuredContent: PAYLOAD })),
    })
    const result = await runDirect(hostOf(connection), { calls: [{ target: 'fx.ping' }] })
    const texts = result.calls[0]!.blocks.filter(b => b.kind === 'text')
    expect(texts).toHaveLength(1)
    expect(JSON.parse(texts[0]!.kind === 'text' ? texts[0]!.text : '')).toEqual(PAYLOAD)
  })

  it('reports an empty reply instead of inventing content', async () => {
    const connection = fakeConnection({ call: vi.fn(async () => ({ content: [] })) })
    const result = await runDirect(hostOf(connection), { calls: [{ target: 'fx.ping' }] })
    const texts = result.calls[0]!.blocks.filter(b => b.kind === 'text')
    expect(texts).toHaveLength(1)
    expect(texts[0]!.kind === 'text' ? texts[0]!.text : '').toBe('(no content)')
  })
})

describe('buildProgram', () => {
  it('renders one await per call with titles as comments', () => {
    const source = buildProgram({ calls: [{ target: 'fx.ping', title: '探活' }, { target: 'fx.push', args: { tag: 't' } }] })
    expect(source).toContain('// 探活')
    expect(source).toContain('await tools["fx.ping"]')
    expect(source).toContain('await tools["fx.push"]')
  })
})

describe('the program data channel', () => {
  it('hands a program the object the kernel would have handed it', async () => {
    // Kernel parity: node-repl-runtime's cell receives `structuredContent ?? content`
    // (`catalog.ts:655`), so `cap.idea.search_text` arrives as an object whose
    // `items` is readable directly. A face carrying only the rendered text makes a
    // program JSON.parse the same data out of a string instead.
    const connection = fakeConnection({
      call: vi.fn(async () => ({
        content: [{ type: 'text', text: '{"items":[{"filePath":"A.java"}],"more":true}' }],
        structuredContent: { items: [{ filePath: 'A.java' }], more: true },
      })),
    })
    const result = await runDirect(hostOf(connection), { calls: [{ target: 'fx.ping' }] })
    const data = result.calls[0]!.data as { items: unknown[]; more: boolean }
    expect(data.items).toHaveLength(1)
    expect(data.more).toBe(true)
    // and the model-facing side is unchanged: the server's own compact text
    expect(result.calls[0]!.blocks).toEqual([
      { kind: 'text', text: '{"items":[{"filePath":"A.java"}],"more":true}' },
    ])
  })

  it('omits data entirely when the server sends no structuredContent', async () => {
    const result = await runDirect(hostOf(fakeConnection()), { calls: [{ target: 'fx.ping' }] })
    expect('data' in (result.calls[0] as object)).toBe(false)
  })

  it('treats an explicit null as sent', async () => {
    // `Object.hasOwn`, not a truthiness test: a server that answers with an
    // explicit null has answered, and `undefined` is what "absent" means here.
    const connection = fakeConnection({ call: vi.fn(async () => ({ content: [], structuredContent: null })) })
    const result = await runDirect(hostOf(connection), { calls: [{ target: 'fx.ping' }] })
    expect('data' in (result.calls[0] as object)).toBe(true)
    expect(result.calls[0]!.data).toBeNull()
  })
})
