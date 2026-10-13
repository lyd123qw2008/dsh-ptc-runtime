import { describe, expect, it, vi } from 'vitest'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { createCapTools, type PtcCapHost } from '../src/index.js'
import type { ProviderConnection } from '@lyd123qw2008/dsh-ptc-runtime'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
const OPERATIONS = [
  { name: 'shot', summary: '', safety: 'read' as const, inputSchema: { type: 'object' as const, properties: {} } },
  { name: 'ping', summary: '', safety: 'read' as const, inputSchema: { type: 'object' as const, properties: {} } },
]

const imageReply = () => ({
  content: [{ type: 'text', text: 'Took a screenshot.' }, { type: 'image', data: PNG, mimeType: 'image/png' }],
})

function hostOf(options: {
  reply?: () => unknown
  saveImages?: (images: readonly { data: Buffer }[]) => Promise<unknown[]>
  modalities?: string[]
}): PtcCapHost {
  const reply = options.reply ?? imageReply
  const connection: ProviderConnection = {
    id: 'fx',
    label: 'fixture',
    operations: OPERATIONS,
    call: async () => reply(),
    close: async () => {},
  }
  const host: PtcCapHost = {
    providers: () => [connection],
    failures: () => [],
    spec: () => undefined,
    refresh: async () => {},
    call: async () => reply(),
  }
  if (options.saveImages !== undefined) {
    const save = options.saveImages
    host.attachments = () => ({ saveImages: save } as unknown as AttachmentStore)
  }
  if (options.modalities !== undefined) {
    host.llm = () => ({ resolveModelInfo: async () => ({ inputModalities: options.modalities }) })
  }
  return host
}

const textOnlyExec = { agent: { session: { requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) } } }
const asTool = (host: PtcCapHost) => {
  const [, call] = createCapTools(host)
  return call as unknown as { execute(args: unknown, exec: unknown): Promise<any> }
}

describe('cap_call image routing', () => {
  it('does not persist pixels for a model that cannot read them', async () => {
    const save = vi.fn(async () => [{ attachmentId: 'att-1', mediaType: 'image/png', bytes: 68, width: 1, height: 1 }])
    const value = await asTool(hostOf({ saveImages: save, modalities: ['text'] })).execute({ target: 'fx.shot' }, textOnlyExec)
    expect(save).not.toHaveBeenCalled()
    expect(value.blocks.map((block: { kind: string }) => block.kind)).toEqual(['text', 'text'])
    expect(value.blocks[1].text).toContain('does not declare image input')
    // A refused image is not an image any more.
    expect(value.images).toEqual([])
  })

  it('stores and delivers for a model that reads images', async () => {
    const save = vi.fn(async () => [{ attachmentId: 'att-1', mediaType: 'image/png', bytes: 68, width: 1, height: 1 }])
    const value = await asTool(hostOf({ saveImages: save, modalities: ['text', 'image'] })).execute({ target: 'fx.shot' }, textOnlyExec)
    expect(save).toHaveBeenCalledTimes(1)
    expect(value.blocks.map((block: { kind: string }) => block.kind)).toEqual(['text', 'image'])
    expect(value.images).toHaveLength(1)
    expect(value.images[0].kind).toBe('attachment')
  })

  it('keeps text when the attachment store fails', async () => {
    const value = await asTool(hostOf({
      saveImages: async () => { throw new Error('store exploded') },
      modalities: ['text', 'image'],
    })).execute({ target: 'fx.shot' }, textOnlyExec)
    expect(value.blocks[0]).toEqual({ kind: 'text', text: 'Took a screenshot.' })
    expect(value.images).toEqual([])
  })
})

describe('cap_call data normalization', () => {
  it('normalizes a wire-reachable non-finite number instead of failing the run', async () => {
    // `{"n": 1e999}` is legal JSON that parses to Infinity; verbatim it failed the
    // host's completion gate with `invalid-output: program completion must be lossless JSON`.
    const reply = () => ({ content: [{ type: 'text', text: 'ok' }], structuredContent: JSON.parse('{"n": 1e999}') })
    const value = await asTool(hostOf({ reply })).execute({ target: 'fx.ping' }, {})
    expect(value.data).toEqual({ n: null })
    expect(JSON.parse(JSON.stringify(value.data))).toEqual(value.data)
  })

  it('leaves ordinary structuredContent untouched', async () => {
    const structuredContent = { items: [1, 2], more: true }
    const reply = () => ({ content: [{ type: 'text', text: 'ok' }], structuredContent })
    const value = await asTool(hostOf({ reply })).execute({ target: 'fx.ping' }, {})
    expect(value.data).toEqual(structuredContent)
  })

  it('still reports an explicit null as sent', async () => {
    const reply = () => ({ content: [], structuredContent: null })
    const value = await asTool(hostOf({ reply })).execute({ target: 'fx.ping' }, {})
    expect('data' in value).toBe(true)
    expect(value.data).toBeNull()
  })
})
