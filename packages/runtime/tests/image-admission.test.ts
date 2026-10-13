import { describe, expect, it, vi } from 'vitest'
import { runDirect, toResultBlocks } from '../src/ptc.js'
import type { ProviderConnection } from '../src/types.js'

// Two DIFFERENT images so a misattribution is observable: `PNG` is admitted,
// `GIF` is refused by the MIME allowlist. Base64 payloads are real enough for
// admission's length-based size estimate.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
const GIF = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

const host = { providers: () => [], spec: () => undefined }

describe('image admission keeps every block aligned with its own image', () => {
  it('marks a refused image as dropped even when an admitted image follows it', async () => {
    // The refused block comes FIRST, which is what desynchronises a positional
    // lookup: the old code counted image blocks in `content` but indexed the
    // already-filtered admitted list, so every block after a drop took its
    // neighbour's image. Measured before the fix: the GIF reported the PNG's
    // hash and the PNG reported hash "dropped".
    const result = {
      content: [
        { type: 'image', data: GIF, mimeType: 'image/gif' },
        { type: 'image', data: PNG, mimeType: 'image/png' },
      ],
    }
    const blocks = await toResultBlocks(host, 'fx', 'shot', result, 'metadata-only')
    const metas = blocks.filter(block => block.kind === 'image-meta') as { hash: string; mimeType: string; bytes: number }[]
    expect(metas).toHaveLength(2)
    // The refused GIF: no image, no hash, its own MIME.
    expect(metas[0]!.hash).toBe('dropped')
    expect(metas[0]!.bytes).toBe(0)
    expect(metas[0]!.mimeType).toBe('image/gif')
    // The admitted PNG: its own real metadata, never the dropped sentinel.
    expect(metas[1]!.hash).not.toBe('dropped')
    expect(metas[1]!.bytes).toBeGreaterThan(0)
    expect(metas[1]!.mimeType).toBe('image/png')
  })

  it('never gives a refused image the admitted image attachment', async () => {
    const saved: number[] = []
    const saveHost = {
      providers: () => [],
      spec: () => undefined,
      saveImages: async (images: readonly { data: Buffer }[]) => {
        saved.push(images.length)
        return images.map((_image, index) => ({
          attachmentId: `att-${index}`,
          mediaType: 'image/png',
          bytes: 68,
        }))
      },
    }
    const result = {
      content: [
        { type: 'image', data: GIF, mimeType: 'image/gif' },
        { type: 'image', data: PNG, mimeType: 'image/png' },
      ],
    }
    const blocks = await toResultBlocks(saveHost, 'fx', 'shot', result, 'inline')
    // Exactly one image was admitted, so the store saw exactly one.
    expect(saved).toEqual([1])
    const imageBlocks = blocks.filter(block => block.kind === 'image') as { attachment: { attachmentId: string } }[]
    const metas = blocks.filter(block => block.kind === 'image-meta') as { hash: string }[]
    // One delivered attachment (the PNG) and one dropped placeholder (the GIF) —
    // the refused block must NOT have become an image block carrying the PNG's
    // attachment, which is what the old positional lookup did.
    expect(imageBlocks).toHaveLength(1)
    expect(metas).toHaveLength(1)
    expect(metas[0]!.hash).toBe('dropped')
    expect(blocks[0]!.kind).toBe('image-meta')
    expect(blocks[1]!.kind).toBe('image')
  })

  it('keeps admitted images aligned when several are interleaved with text', async () => {
    const result = {
      content: [
        { type: 'text', text: 'first' },
        { type: 'image', data: GIF, mimeType: 'image/gif' },
        { type: 'text', text: 'middle' },
        { type: 'image', data: PNG, mimeType: 'image/png' },
        { type: 'text', text: 'last' },
      ],
    }
    const blocks = await toResultBlocks(host, 'fx', 'shot', result, 'metadata-only')
    // The trailing text is the drop notice, which is appended once at the end.
    expect(blocks.map(block => block.kind)).toEqual(['text', 'image-meta', 'text', 'image-meta', 'text', 'text'])
    const metas = blocks.filter(block => block.kind === 'image-meta') as { hash: string }[]
    expect(metas[0]!.hash).toBe('dropped')
    expect(metas[1]!.hash).not.toBe('dropped')
  })

  it('still reports a genuine drop once, in the tail text', async () => {
    const result = {
      content: [
        { type: 'image', data: GIF, mimeType: 'image/gif' },
        { type: 'image', data: PNG, mimeType: 'image/png' },
      ],
    }
    const blocks = await toResultBlocks(host, 'fx', 'shot', result, 'metadata-only')
    const tail = blocks.filter(block => block.kind === 'text').map(block => (block as { text: string }).text)
    expect(tail).toEqual(['[1 image(s) omitted: outside the admission budget]'])
  })
})

describe('runDirect image path', () => {
  it('returns aligned metadata through a real program call', async () => {
    const connection: ProviderConnection = {
      id: 'fx',
      label: 'fixture',
      operations: [{ name: 'shot', summary: 'Take a screenshot.', safety: 'read', inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false } }],
      call: vi.fn(async () => ({
        content: [
          { type: 'text', text: 'Took a screenshot.' },
          { type: 'image', data: GIF, mimeType: 'image/gif' },
          { type: 'image', data: PNG, mimeType: 'image/png' },
        ],
      })),
      close: vi.fn(async () => {}),
    }
    const result = await runDirect(
      { providers: () => [connection], spec: () => undefined },
      { calls: [{ target: 'fx.shot', deliver: 'metadata-only' }] },
    )
    expect(result.ok).toBe(true)
    const metas = result.calls[0]!.blocks.filter(block => block.kind === 'image-meta') as { hash: string }[]
    expect(metas).toHaveLength(2)
    expect(metas[0]!.hash).toBe('dropped')
    expect(metas[1]!.hash).not.toBe('dropped')
  })
})
