import { describe, expect, it, vi } from 'vitest'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { CAP_TOOL_NAMES, createCapTools, type PtcCapHost } from '../src/index.js'
import type { ProviderConnection } from '@lyd123qw2008/dsh-ptc-runtime'

function estimatedToolsTokens(declarations: unknown): number {
  return Math.ceil(JSON.stringify(declarations).length / 4) + 4
}

type Rendered = { readonly type: string; readonly text?: string; readonly attachment?: unknown }
type ToolShape = {
  readonly name: string
  readonly description: string
  readonly parameters: unknown
  execute(args: unknown, exec: unknown): Promise<unknown>
  readonly output: { render(args: unknown, value: unknown): Rendered[] }
  readonly presentCall?: (args: unknown) => { readonly title?: string; readonly rawInput?: unknown } | undefined
}

const asTool = (tool: unknown): ToolShape => tool as ToolShape
const exec = {} as ToolRunContext

const OPERATIONS = [
  { name: 'ping', summary: 'Return a small value.', safety: 'read' as const, inputSchema: { type: 'object' as const, properties: {}, required: [], additionalProperties: false as const } },
  { name: 'push', summary: 'Mutate something.', safety: 'mutate' as const, inputSchema: { type: 'object' as const, properties: { tag: { type: 'string' } }, required: ['tag'], additionalProperties: false as const } },
  { name: 'shot', summary: 'Take a screenshot.', safety: 'read' as const, inputSchema: { type: 'object' as const, properties: {}, required: [], additionalProperties: false as const } },
]

function fakeHost(overrides: Partial<PtcCapHost> = {}): PtcCapHost {
  const connection: ProviderConnection = {
    id: 'fx',
    label: 'fixture',
    operations: OPERATIONS,
    call: vi.fn(async () => ({ content: [{ type: 'text', text: 'pong' }] })),
    close: vi.fn(async () => {}),
  }
  return {
    providers: () => [connection],
    failures: () => [{ id: 'broken', error: 'tools/list failed' }],
    spec: id => (id === 'fx' ? { id: 'fx', transport: 'stdio', command: 'node', inject: { projectPath: 'D:/proj' } } : undefined),
    refresh: vi.fn(async () => {}),
    call: vi.fn(async (_provider, _operation, args) => ({ content: [{ type: 'text', text: JSON.stringify(args) }] })),
    ...overrides,
  }
}

const textOf = (tool: ToolShape, value: unknown): string =>
  tool.output.render({}, value).map(block => block.text ?? '').join('\n')

describe('the two-tool face', () => {
  const tools = createCapTools(fakeHost())

  it('stays exactly two tools inside the declaration budget', () => {
    expect(tools.map(tool => tool.name)).toEqual([...CAP_TOOL_NAMES])
    const tokens = estimatedToolsTokens(tools.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters })))
    // The M1 budget (DESIGN §4) is 1200. This assertion used to say 1600, which is
    // 33% looser than the documented budget: a regression from the current 1183 to
    // 1300 would have passed the test while violating M1. Assert what the design
    // actually promises. Measured 2026-10-13 by `node scripts/bench-tokens.mjs`:
    // 1183 total (cap_help 433, cap_call 750) — 17 tokens of headroom.
    expect(tokens).toBeLessThanOrEqual(1200)
  })

  it('lists providers and failed attaches at the first level', async () => {
    const [help] = tools.map(asTool)
    const value = await help.execute({}, exec) as { kind: string }
    expect(value.kind).toBe('catalog')
    expect(textOf(help, value)).toContain('fx — 3 operations')
  })

  it('lists operations at the second level as data', async () => {
    const [help] = tools.map(asTool)
    const value = await help.execute({ target: 'fx' }, exec) as { kind: string; operations: { name: string }[] }
    expect(value.kind).toBe('operations')
    expect(value.operations.map(operation => operation.name)).toEqual(['ping', 'push', 'shot'])
  })

  it('returns one operation schema at the third level', async () => {
    const [help] = tools.map(asTool)
    const value = await help.execute({ target: 'fx.push' }, exec) as { kind: string; operation: string }
    expect(value.kind).toBe('operation')
    expect(value.operation).toBe('push')
  })

  it('returns batch schemas in one call', async () => {
    const [help] = tools.map(asTool)
    const value = await help.execute({ target: 'fx.ping, fx.push' }, exec) as { kind: string; operations: { operation: string }[] }
    expect(value.kind).toBe('operations-batch')
    expect(value.operations.map(operation => operation.operation)).toEqual(['ping', 'push'])
  })

  it('rejects oversized batches', async () => {
    const [help] = tools.map(asTool)
    const many = Array.from({ length: 9 }, (_, i) => `fx.op${i}`).join(',')
    await expect(help.execute({ target: many }, exec)).rejects.toThrow(/at most 8/)
  })

  it('declares the qualified target first', () => {
    const [help, call] = createCapTools(fakeHost()).map(asTool)
    const firstProperty = (tool: ToolShape): string =>
      Object.keys((tool.parameters as { properties: Record<string, unknown> }).properties)[0] ?? ''
    expect(firstProperty(call)).toBe('target')
    expect(firstProperty(help)).toBe('target')
  })

  it('never forwards the display-only title to the provider', async () => {
    const host = fakeHost()
    const [, call] = createCapTools(host).map(asTool)
    await call.execute({ target: 'fx.push', title: '只看不传', args: { tag: 't' } }, exec)
    expect(host.call).toHaveBeenCalledWith('fx', 'push', { tag: 't' }, undefined)
  })
})

describe('cap_call', () => {
  it('refuses a host-owned argument instead of overwriting it', async () => {
    const host = fakeHost()
    const [, call] = createCapTools(host).map(asTool)
    await expect(call.execute({ target: 'fx.ping', args: { projectPath: 'D:/elsewhere' } }, exec))
      .rejects.toThrow(/projectPath is host-owned/)
    expect(host.call).not.toHaveBeenCalled()
  })

  it('turns a provider-reported failure into a tool error', async () => {
    const host = fakeHost({
      call: vi.fn(async () => ({ isError: true, content: [{ type: 'text', text: 'fixture failure' }] })),
    })
    const [, call] = createCapTools(host).map(asTool)
    await expect(call.execute({ target: 'fx.ping' }, exec)).rejects.toThrow('fixture failure')
  })

  it('carries the provider payload on the value, never in the model text', async () => {
    // The program reads `data`; the model reads the rendered blocks. Both come
    // from the same reply, and only the model-facing half is content-only.
    const host = fakeHost({
      call: vi.fn(async () => ({
        content: [{ type: 'text', text: '{"items":[1],"more":true}' }],
        structuredContent: { items: [1], more: true },
      })),
    })
    const [, call] = createCapTools(host).map(asTool)
    const value = await call.execute({ target: 'fx.ping' }, exec) as { data?: unknown }
    expect(value.data).toEqual({ items: [1], more: true })
    expect(textOf(call, value)).toBe('{"items":[1],"more":true}')
  })

  it('omits data when the server sent no structuredContent', async () => {
    const [, call] = createCapTools(fakeHost()).map(asTool)
    const value = await call.execute({ target: 'fx.ping' }, exec) as object
    expect('data' in value).toBe(false)
  })
})

describe('images', () => {
  const REF = { attachmentId: 'attachment-1', mediaType: 'image/png', bytes: 3 } as unknown as ImageAttachmentRef
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

  it('returns metadata-only images without delivering pixels', async () => {
    const host = fakeHost({
      call: vi.fn(async () => ({ content: [{ type: 'image', data: PNG, mimeType: 'image/png' }] })),
      attachments: () => ({ saveImages: async () => [REF] } as unknown as AttachmentStore),
    })
    const [, call] = createCapTools(host).map(asTool)
    const value = await call.execute({ target: 'fx.shot', deliver: 'metadata-only' }, exec) as {
      blocks: { kind: string; mimeType?: string; bytes?: number; hash?: string }[]
    }
    expect(value.blocks[0]!.kind).toBe('image-meta')
    expect(value.blocks[0]!.bytes).toBeGreaterThan(0)
  })

  it('lifts image metadata clear of the blocks, where the prose comes first', async () => {
    // playwright answers browser_take_screenshot as [text, image-meta]. A program that
    // reaches for blocks[0].bytes gets undefined, which fails the whole run as
    // non-lossless JSON — measured on 3108, 2026-10-12.
    const host = fakeHost({
      call: vi.fn(async () => ({
        content: [
          { type: 'text', text: 'Took a screenshot.' },
          { type: 'image', data: PNG, mimeType: 'image/png' },
        ],
      })),
      attachments: () => ({ saveImages: async () => [REF] } as unknown as AttachmentStore),
    })
    const [, call] = createCapTools(host).map(asTool)
    const value = await call.execute({ target: 'fx.shot', deliver: 'metadata-only' }, exec) as {
      blocks: { kind: string }[]
      images: Record<string, unknown>[]
    }
    expect(value.blocks.map(block => block.kind)).toEqual(['text', 'image-meta'])
    expect(value.images).toHaveLength(1)
    expect(value.images[0]).toMatchObject({ kind: 'meta', mimeType: 'image/png' })
    expect(value.images[0]!.bytes).toBeGreaterThan(0)
    expect(value.images[0]!.hash).toBeTypeOf('string')
    // No key may hold `undefined`: that is exactly what fails a completion.
    expect(Object.entries(value.images[0]!).filter(([, held]) => held === undefined)).toEqual([])
  })

  it('reports an empty images array for a reply with no image', async () => {
    const [, call] = createCapTools(fakeHost()).map(asTool)
    const value = await call.execute({ target: 'fx.ping' }, exec) as { images: unknown[] }
    expect(value.images).toEqual([])
  })

  it('summarises an inline image as an attachment, still with no undefined keys', async () => {
    // The other arm of CapImageSummary. REF carries no width/height, so those must be
    // ABSENT keys rather than undefined ones — the whole point of the conditional spread.
    const host = fakeHost({
      call: vi.fn(async () => ({
        content: [
          { type: 'text', text: 'Took a screenshot.' },
          { type: 'image', data: PNG, mimeType: 'image/png' },
        ],
      })),
      attachments: () => ({ saveImages: async () => [REF] } as unknown as AttachmentStore),
    })
    const [, call] = createCapTools(host).map(asTool)
    const value = await call.execute({ target: 'fx.shot' }, exec) as { images: Record<string, unknown>[] }
    expect(value.images).toHaveLength(1)
    expect(value.images[0]).toMatchObject({
      kind: 'attachment',
      attachmentId: 'attachment-1',
      mediaType: 'image/png',
      bytes: 3,
    })
    expect('width' in value.images[0]!).toBe(false)
    expect('height' in value.images[0]!).toBe(false)
    expect(Object.entries(value.images[0]!).filter(([, held]) => held === undefined)).toEqual([])
  })
})
