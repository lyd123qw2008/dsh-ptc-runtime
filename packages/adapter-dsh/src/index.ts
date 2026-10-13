/**
 * The model-facing face: exactly two tools.
 *
 * Mirrors `node-repl-runtime/packages/adapter-dsh/src/index.ts` in role and
 * `dsh-cap-catalog/src/tools.ts` in behavior: `cap_help` is the discovery path
 * (three levels, batch-capable), `cap_call` is the single door. Neither grows
 * with the number of attached servers.
 *
 * PTC differences from both references:
 *   - no persistent kernel behind the face: `runProgram` executes one batched
 *     program directly against providers (native presentation);
 *   - `deliver` selects image capture-vs-delivery per call;
 *   - third-level `cap_help` accepts comma-separated batch targets.
 */

import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import type { AttachmentStore, ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { providerStructuredContent, splitBatchTarget, splitTarget, toLosslessJson, toResultBlocks, type PtcHost } from '@lyd123qw2008/dsh-ptc-runtime'
import type { McpProviderSpec, ProviderConnection, ProviderFailure } from '@lyd123qw2008/dsh-ptc-runtime'
import { CAP_CALL_TOOL_DESCRIPTION, CAP_HELP_TOOL_DESCRIPTION } from './descriptions.js'

export * from './descriptions.js'

/** Names are fixed: the model surface must not vary with what is attached. */
export const CAP_TOOL_NAMES = ['cap_help', 'cap_call'] as const

type ParameterSchemaSpec = Record<string, Record<string, unknown>>

const HELP_PARAMETERS = {
  target: {
    type: 'string',
    description: 'Qualified target, cheapest level first: omit it to list every attached provider; `"provider"` to list that provider\'s operations; `"provider.operation"` for one operation\'s schema; comma-separated qualified targets (up to 8) for batch schema lookup.',
  },
  title: {
    type: 'string',
    description: 'Optional short, single-line, user-visible label for this call. Display only — never sent to the provider.',
  },
  refresh: {
    type: 'boolean',
    description: 'Re-read the servers\' own catalogs first, so a server that started or changed since mount is picked up.',
  },
} as const satisfies ParameterSchemaSpec

const CALL_PARAMETERS = {
  target: {
    type: 'string',
    required: true,
    description: 'Qualified target `provider.operation`, exactly as cap_help lists it (e.g. "playwright.browser_navigate"). One string, because the operation alone is ambiguous across providers and the provider alone names no work.',
  },
  args: {
    type: 'object',
    additionalProperties: true,
    description: 'Arguments for the operation, exactly as its schema declares them (cap_help with the qualified target returns that schema).',
  },
  deliver: {
    type: 'string',
    enum: ['inline', 'metadata-only'],
    description: 'Image delivery. "inline" (the default) lets an image enter the conversation; "metadata-only" returns sizes and hashes for aggregation without delivering pixels. The only two accepted values: anything else is refused, because a typo here used to be read as "inline" and would leak pixels into the conversation silently.',
  },
  title: {
    type: 'string',
    description: 'Optional short, single-line, user-visible label for this call. Display only — never sent to the provider.',
  },
} as const satisfies ParameterSchemaSpec

export interface PtcCapHost {
  readonly providers: () => readonly ProviderConnection[]
  readonly failures: () => readonly ProviderFailure[]
  readonly spec: (id: string) => McpProviderSpec | undefined
  readonly refresh: () => Promise<void>
  readonly call: (
    provider: string,
    operation: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ) => Promise<unknown>
  readonly attachments?: () => AttachmentStore | undefined
  readonly llm?: () => ImageRouteProbe | undefined
}

export interface ImageRouteProbe {
  resolveModelInfo(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{ readonly inputModalities?: readonly string[] }>
}

type CapBlock =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'image'; readonly attachment: ImageAttachmentRef }
  | { readonly kind: 'image-meta'; readonly mimeType: string; readonly bytes: number; readonly hash: string }

/**
 * One image from a call's reply, with its metadata lifted clear of the blocks.
 *
 * `blocks` keeps the server's own order, so an image is NOT necessarily at index 0:
 * playwright answers `browser_take_screenshot` as `[text, image]` (or
 * `[text, image-meta]` under `deliver: "metadata-only"`). A program that reaches for
 * `blocks[0].bytes` therefore gets `undefined` exactly when an image is present, and
 * that property then fails the whole run with
 * `code run failed (invalid-output): program completion must be lossless JSON`.
 * Measured 2026-10-12: `kinds: ["text","image-meta"]`, so `blocks[0].bytes` was
 * `undefined` while the real image-meta block had both fields.
 *
 * This array is what a program should read instead. It is always present (empty for
 * a reply with no image), so aggregating never needs an index or a `find`.
 *
 * `bytes` is NOT the same quantity in the two arms, and that is inherent rather than
 * an oversight: a `meta` arm never sees the stored bytes, so it reports what the
 * SERVER sent (derived from the base64 payload length); an `attachment` arm reports
 * what the STORE saved after normalization. Measured on one page 2026-10-12: 9912 vs
 * 9911. Good enough to compare sizes across pages; it is not a checksum, so do not
 * use it as one.
 */
export type CapImageSummary =
  | { readonly kind: 'meta'; readonly mimeType: string; readonly bytes: number; readonly hash: string }
  | {
    readonly kind: 'attachment'
    readonly attachmentId: string
    readonly mediaType: string
    readonly bytes: number
    readonly width?: number
    readonly height?: number
  }

function imagesOf(blocks: readonly CapBlock[]): readonly CapImageSummary[] {
  const images: CapImageSummary[] = []
  for (const block of blocks) {
    if (block.kind === 'image-meta') {
      images.push({ kind: 'meta', mimeType: block.mimeType, bytes: block.bytes, hash: block.hash })
      continue
    }
    if (block.kind !== 'image') continue
    const ref = block.attachment
    images.push({
      kind: 'attachment',
      attachmentId: String(ref.attachmentId),
      mediaType: String(ref.mediaType),
      bytes: ref.bytes,
      // Conditional so an absent dimension is an ABSENT KEY, never `undefined`: a
      // property whose value is `undefined` is the very thing that makes a
      // downstream completion non-lossless.
      ...typeof ref.width === 'number' ? { width: ref.width } : {},
      ...typeof ref.height === 'number' ? { height: ref.height } : {},
    })
  }
  return images
}

function forToolContract(value: unknown): never {
  return value as never
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

function toContentBlock(block: CapBlock): ContentBlock {
  if (block.kind === 'text') return { type: 'text', text: block.text }
  if (block.kind === 'image') return { type: 'image', attachment: block.attachment }
  return { type: 'text', text: `[image metadata: ${block.mimeType} ${block.bytes} bytes sha ${block.hash}]` }
}

function unknownValue(value: unknown): ContentBlock[] {
  return Array.isArray((value as { blocks?: unknown } | null)?.blocks)
    ? ((value as { blocks: readonly CapBlock[] }).blocks).map(toContentBlock)
    : [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

function imageAttachmentName(mediaType: string): string {
  const slash = mediaType.indexOf('/')
  const subtype = slash === -1 ? '' : mediaType.slice(slash + 1)
  if (subtype === '') return 'dsh-ptc-runtime'
  return `dsh-ptc-runtime.${subtype === 'jpeg' ? 'jpg' : subtype}`
}

function routeOf(exec: unknown): { provider?: string; model?: string } {
  const agent = (exec as {
    agent?: {
      session?: { requestHeader?: () => { config?: { provider?: string; model?: string } } | undefined }
      options?: { provider?: string; model?: string }
    }
  } | undefined)?.agent
  const routed = agent?.session?.requestHeader?.()?.config
  const provider = routed?.provider ?? agent?.options?.provider
  const model = routed?.model ?? agent?.options?.model
  const route: { provider?: string; model?: string } = {}
  if (provider !== undefined) route.provider = provider
  if (model !== undefined) route.model = model
  return route
}

async function imageRouteRefusal(host: PtcCapHost, exec: unknown): Promise<string | undefined> {
  const route = routeOf(exec)
  const llm = host.llm?.()
  if (llm === undefined || route.provider === undefined || route.model === undefined) return undefined
  try {
    const info = await llm.resolveModelInfo(route.provider, route.model)
    if (info.inputModalities?.includes('image') === true) return undefined
    return `model "${route.model}" does not declare image input`
  } catch {
    return undefined
  }
}

function asPtcHost(host: PtcCapHost): PtcHost {
  return {
    providers: host.providers,
    spec: host.spec,
    saveImages: host.attachments === undefined ? undefined : async (images) => {
      const store = host.attachments!()
      if (store === undefined) throw new Error('no attachment store is mounted')
      // The store's refs are passed through AS IS. Rebuilding one here would drop
      // `bytes`/`width`/`height` that admission measured from the stored bytes, and
      // those are exactly what a later `metadata-only` aggregation wants to report.
      return await store.saveImages(images.map(image => ({
        data: image.data,
        mediaType: image.mediaType as ImageMediaType,
        name: image.name,
      })))
    },
  }
}

interface CapCatalogValue {
  readonly kind: 'catalog'
  readonly providers: readonly { readonly id: string; readonly operationCount: number; readonly sample: readonly string[] }[]
  readonly notAttached: readonly { readonly id: string; readonly error: string }[]
}

interface CapOperationsValue {
  readonly kind: 'operations'
  readonly provider: string
  readonly operations: readonly { readonly name: string; readonly safety: string; readonly summary: string }[]
}

interface CapOperationValue {
  readonly kind: 'operation'
  readonly provider: string
  readonly operation: string
  readonly safety: string
  readonly summary: string
  readonly inputSchema: Readonly<Record<string, unknown>>
  readonly outputSchema?: Readonly<Record<string, unknown>>
}

interface CapBatchValue {
  readonly kind: 'operations-batch'
  readonly operations: readonly CapOperationValue[]
}

interface CapCallValue {
  readonly provider: string
  readonly operation: string
  readonly blocks: readonly CapBlock[]
  /**
   * Every image in the reply, in server order, always present (empty when there is
   * none). Read this instead of indexing `blocks`: see {@link CapImageSummary} for
   * the `undefined` this exists to prevent.
   */
  readonly images: readonly CapImageSummary[]
  /**
   * The provider's own `structuredContent`, verbatim, when that server sent one.
   *
   * `blocks` is rendered from `content` and is what the MODEL reads. This is what a
   * PROGRAM reads, so a `run_code` body writes `data.items` instead of parsing
   * `blocks[0].text`. It rides in the tool VALUE, which never reaches the model:
   * the registry keeps only the outer curated `run_code` result ("only the outer
   * curated result enters model history" — `core/tools/src/ptc.ts`), and the
   * `tool/ptc-dispatch` log carries the rendered content, not this. So carrying it
   * costs no context; the kernel runtime gave its cell the same payload
   * (`catalog.ts:655`).
   */
  readonly data?: unknown
}

/**
 * Build the two tool definitions.
 *
 * Ordinary DSH tools on purpose: in native presentation the model calls them
 * directly, under PTC they appear as SDK bindings inside a program, and either
 * way every invocation goes through the harness pipeline.
 */
export function createCapTools(host: PtcCapHost) {
  const helpTool = defineTool({
    name: CAP_TOOL_NAMES[0],
    description: CAP_HELP_TOOL_DESCRIPTION,
    parameters: HELP_PARAMETERS,
    presentCall(args: { target?: string; title?: string }) {
      return {
        card: 'generic' as const,
        kind: 'read' as const,
        title: args.title?.trim() || args.target?.trim() || 'capability catalog',
      }
    },
    output: {
      schema: { type: 'json' } as const,
      render(_args: unknown, value: unknown): ContentBlock[] {
        const help = value as { kind?: unknown }
        if (help.kind === 'operations' || help.kind === 'operation' || help.kind === 'operations-batch') {
          return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
        }
        if (help.kind !== 'catalog') return unknownValue(value)
        const catalog = value as CapCatalogValue
        const lines = catalog.providers.map(provider =>
          `${provider.id} — ${provider.operationCount} operations`
          + (provider.sample.length === 0 ? '' : ` (e.g. ${provider.sample.join(', ')})`))
        const absent = catalog.notAttached.map(failure => `${failure.id} — NOT ATTACHED: ${failure.error}`)
        const all = [...lines, ...absent]
        return [{ type: 'text', text: all.length === 0 ? 'no providers are configured' : all.join('\n') }]
      },
    },
    async execute(args: { target?: string; refresh?: boolean }) {
      if (args.refresh === true) await host.refresh()
      const providers = host.providers()
      const failures = host.failures()
      const target = args.target?.trim() ?? ''
      if (target === '') {
        return forToolContract({
          kind: 'catalog',
          providers: providers.map(provider => ({
            id: provider.id,
            operationCount: provider.operations.length,
            sample: provider.operations.slice(0, 3).map(operation => operation.name),
          })),
          notAttached: failures.map(failure => ({ id: failure.id, error: failure.error })),
        } satisfies CapCatalogValue)
      }
      if (!target.includes('.')) {
        const connection = providers.find(candidate => candidate.id === target)
        if (connection === undefined) {
          const failed = failures.find(failure => failure.id === target)
          if (failed !== undefined) throw new Error(`provider "${failed.id}" is not attached: ${failed.error}`)
          const known = [...providers.map(provider => provider.id), ...failures.map(failure => failure.id)]
          throw new Error(`unknown provider "${target}"; known providers: ${known.join(', ') || 'none'}`)
        }
        return forToolContract({
          kind: 'operations',
          provider: connection.id,
          operations: connection.operations.map(operation => ({
            name: operation.name,
            safety: operation.safety,
            summary: operation.summary.split('\n')[0]?.slice(0, 200) ?? '',
          })),
        } satisfies CapOperationsValue)
      }
      const batch = splitBatchTarget(target)
      const found: CapOperationValue[] = []
      for (const item of batch) {
        const { provider: providerId, operation: operationName } = splitTarget(item)
        const connection = providers.find(candidate => candidate.id === providerId)
        if (connection === undefined) {
          throw new Error(`unknown provider "${providerId}" in target "${item}"; known providers: ${providers.map(provider => provider.id).join(', ') || 'none'}`)
        }
        const operation = connection.operations.find(candidate => candidate.name === operationName)
        if (operation === undefined) {
          throw new Error(`unknown operation "${item}"; available: ${connection.operations.map(candidate => candidate.name).join(', ') || 'none'}`)
        }
        found.push({
          kind: 'operation',
          provider: connection.id,
          operation: operation.name,
          safety: operation.safety,
          summary: operation.summary,
          inputSchema: operation.inputSchema,
          ...operation.outputSchema === undefined ? {} : { outputSchema: operation.outputSchema },
        })
      }
      if (found.length === 1) return forToolContract(found[0])
      return forToolContract({ kind: 'operations-batch', operations: found } satisfies CapBatchValue)
    },
  })

  const callTool = defineTool({
    name: CAP_TOOL_NAMES[1],
    description: CAP_CALL_TOOL_DESCRIPTION,
    parameters: CALL_PARAMETERS,
    presentCall(args: { target: string; args?: unknown; title?: string }) {
      return {
        card: 'generic' as const,
        kind: 'execute' as const,
        title: args.title?.trim() || args.target?.trim() || 'cap_call',
        ...args.args === undefined ? {} : { rawInput: args.args },
      }
    },
    output: {
      schema: { type: 'json' } as const,
      render(_args: unknown, value: unknown): ContentBlock[] {
        const call = value as { blocks?: unknown }
        if (!Array.isArray(call.blocks)) return unknownValue(value)
        return (call.blocks as readonly CapBlock[]).map(toContentBlock)
      },
    },
    async execute(
      args: { target: string; args?: unknown; deliver?: string; title?: string },
      exec: ToolRunContext,
    ) {
      const deliver = args.deliver === 'metadata-only' ? 'metadata-only' : 'inline'
      const target = args.target.trim()
      const { provider: providerId, operation: operationName } = splitTarget(target)
      if (providerId === '' || operationName === undefined) {
        throw new Error(`target must be the qualified "provider.operation" (got ${JSON.stringify(args.target)}); call cap_help with no target to list providers, or with a provider to list its operations`)
      }
      const connection = host.providers().find(candidate => candidate.id === providerId)
      if (connection === undefined) {
        const failed = host.failures().find(failure => failure.id === providerId)
        if (failed !== undefined) throw new Error(`provider "${failed.id}" is not attached: ${failed.error}`)
        const known = [...host.providers().map(provider => provider.id), ...host.failures().map(failure => failure.id)]
        throw new Error(`unknown provider "${providerId}" in target "${target}"; known providers: ${known.join(', ') || 'none'}`)
      }
      const operation = connection.operations.find(candidate => candidate.name === operationName)
      if (operation === undefined) {
        throw new Error(`unknown operation "${target}"; available: ${connection.operations.map(candidate => candidate.name).join(', ') || 'none'}`)
      }
      const provided = (args.args ?? {}) as Record<string, unknown>
      const injected = Object.keys(host.spec(providerId)?.inject ?? {}).filter(key => Object.hasOwn(provided, key))
      if (injected.length > 0) {
        throw new Error(`${injected.join(', ')} ${injected.length === 1 ? 'is' : 'are'} host-owned: ${providerId} supplies ${injected.length === 1 ? 'it' : 'them'} on the host side, so remove ${injected.length === 1 ? 'it' : 'them'} from args`)
      }
      const refusal = await imageRouteRefusal(host, exec)
      const result = await host.call(providerId, operationName, provided, exec.signal)
      const ptcHost = asPtcHost(host)
      // The refusal is handed IN rather than applied afterwards: rewriting the blocks
      // post-hoc still let `toResultBlocks` write the pixels to the attachment store
      // first, so a text-only model left durable images behind that nothing prunes.
      const rawBlocks = await toResultBlocks(ptcHost, providerId, operationName, result, deliver, refusal)
      // Normalized, not verbatim: a server reply is JSON on the wire, so `1e999`
      // parses to `Infinity` and would fail the host's completion gate, killing the
      // run over a legal number. See `toLosslessJson`.
      const data = toLosslessJson(providerStructuredContent(result))
      const blocks: CapBlock[] = rawBlocks.map(block => {
        if (block.kind === 'text') return block
        if (block.kind === 'image-meta') return block
        return { kind: 'image', attachment: block.attachment as unknown as ImageAttachmentRef }
      })
      // `images` is derived from the blocks actually delivered, so a refused image
      // (now text) is not counted as an image either.
      return forToolContract({
        provider: providerId,
        operation: operationName,
        blocks,
        images: imagesOf(blocks),
        ...data === undefined ? {} : { data },
      } satisfies CapCallValue)
    },
  })

  return [helpTool, callTool] as const
}
