/**
 * Assemble and run one batched PTC program.
 *
 * This file replaces `kernel.ts` + `bridge.ts` from node-repl-runtime. There is
 * no persistent kernel, no TCP bridge, no snapshot: the directory lives on the
 * host (`catalog.ts`), and each program run is one-shot — providers are called
 * directly, results are mapped to blocks, and nothing survives the run.
 *
 * Two execution paths, chosen by the caller:
 *   - `runDirect`: call providers straight from the host (native presentation).
 *     Each `PtcProgramCall` becomes one provider call; `deliver` decides whether
 *     an image-bearing result enters the conversation or returns metadata only.
 *   - `buildProgram`: render the program source a `ctx.ptcRuntime` run would
 *     execute (PTC presentation). The program awaits the same bindings several
 *     times, keeping every sub-call visible to the harness as `tool/ptc-dispatch`.
 */

import { createHash } from 'node:crypto'
import { collectProviderImages } from './catalog.js'
import type {
  McpProviderSpec,
  ProviderConnection,
  PtcCallResult,
  PtcImageRef,
  PtcProgramCall,
  PtcProgramRequest,
  PtcProgramResult,
  PtcResultBlock,
} from './types.js'

export interface PtcHost {
  readonly providers: () => readonly ProviderConnection[]
  readonly spec: (id: string) => McpProviderSpec | undefined
  readonly saveImages?: ((images: readonly { data: Buffer; mediaType: string; name: string }[]) => Promise<readonly PtcImageRef[]>) | undefined
  readonly now?: (() => number) | undefined
}

export interface SplitTarget {
  readonly provider: string
  readonly operation?: string
}

/**
 * Split a qualified target into its two halves.
 *
 * The address is one string because it is one thing: `provider.operation`.
 * Splitting at the FIRST dot leaves an operation name free to contain dots
 * (`a.b.c` → provider `a`, operation `b.c`). Mirrors the adapter's split.
 */
export function splitTarget(raw: string): SplitTarget {
  const target = raw.trim()
  const dot = target.indexOf('.')
  if (dot <= 0 || dot === target.length - 1) return { provider: target }
  return { provider: target.slice(0, dot), operation: target.slice(dot + 1) }
}

/** Split a comma-separated batch target into qualified targets (max 8). */
export const MAX_BATCH_TARGETS = 8

export function splitBatchTarget(raw: string): string[] {
  const parts = raw.split(',').map(part => part.trim()).filter(part => part !== '')
  if (parts.length > MAX_BATCH_TARGETS) {
    throw new Error(`at most ${MAX_BATCH_TARGETS} targets per call; got ${parts.length} — split into batches`)
  }
  return parts
}

interface McpContentBlock {
  readonly type?: unknown
  readonly text?: unknown
  readonly data?: unknown
  readonly mimeType?: unknown
}

function imageAttachmentName(mediaType: string): string {
  const slash = mediaType.indexOf('/')
  const subtype = slash === -1 ? '' : mediaType.slice(slash + 1)
  if (subtype === '') return 'dsh-ptc-runtime'
  return `dsh-ptc-runtime.${subtype === 'jpeg' ? 'jpg' : subtype}`
}

/**
 * Map one verbatim MCP envelope into result blocks.
 *
 * `deliver: 'metadata-only'` suppresses pixel delivery: image blocks become
 * `{ kind: 'image-meta', mimeType, bytes, hash }` so a program can aggregate
 * sizes without paying context for pixels. The file-argument detour is never
 * needed — and must not be used, since a file lands in the provider process
 * cwd (the deployment profile), not the session workspace.
 */
export async function toResultBlocks(
  host: PtcHost,
  provider: string,
  operation: string,
  result: unknown,
  deliver: 'inline' | 'metadata-only',
): Promise<readonly PtcResultBlock[]> {
  if (result === null || typeof result !== 'object') {
    return [{ kind: 'text', text: JSON.stringify(result ?? null) }]
  }
  const envelope = result as { content?: readonly McpContentBlock[]; structuredContent?: unknown; isError?: boolean }
  const content = Array.isArray(envelope.content) ? envelope.content : []

  if (envelope.isError === true) {
    const text = content
      .filter(block => block?.type === 'text')
      .map(block => String(block.text ?? ''))
      .join('\n')
      .trim()
    throw new Error(text === '' ? `${provider}.${operation} failed` : text)
  }

  // Render `content` only: `blocks` is what the MODEL reads.
  //
  // `CallToolResultSchema` makes `content` the guaranteed field (`ZodDefault`, so
  // it is present even when a server sends nothing) and `structuredContent` the
  // optional one (`ZodOptional<ZodUnknown>`). `content` is the protocol's primary
  // channel, so it is the one the model reads — and rendering both is what produced
  // the duplicated reply this face exists to remove.
  //
  // This is NOT the kernel's rule, and an earlier version of this comment claimed it
  // was. node-repl-runtime hands its cell `structuredContent ?? content`
  // (`catalog.ts:655`) — one value, preferring the structured form. It never renders
  // for a model, so it never had a duplicate to avoid in the first place. The two
  // consumers are only forced together HERE, where a tool result also becomes
  // model-facing content; so this face splits them instead of collapsing them:
  // `blocks` from `content` for the model, and `providerStructuredContent()` for the
  // program (`PtcCallResult.data`).
  //
  // Measured 2026-10-12 across the four attached providers:
  //
  //   provider    content                          structuredContent
  //   idea        the result as JSON               the SAME value (150,565 chars
  //                                                  each on `search_text`)
  //   playwright  human-readable prose             absent
  //   engram      the result as JSON               absent
  //   cua         human-readable prose             the same result, far larger
  //                                                  (1,942 vs 8,295 chars on
  //                                                  `list_windows`)
  //
  // Cua is why `data` is not merely a convenience: its prose announces its own
  // omissions ("SkyLight Space SPIs unavailable — on_current_space / space_ids
  // omitted") while the structured payload keeps those fields, so a program reading
  // only `content` cannot see what the kernel's cell could.
  const blocks: PtcResultBlock[] = []
  const admitted = collectProviderImages(content)
  let refs: readonly PtcImageRef[] = []
  if (admitted.images.length > 0 && deliver === 'inline' && host.saveImages !== undefined) {
    refs = await host.saveImages(admitted.images.map(image => ({
      data: Buffer.from(image.data, 'base64'),
      mediaType: image.mimeType,
      name: imageAttachmentName(image.mimeType),
    })))
  }
  let imageIndex = 0
  for (const block of content) {
    if (block?.type === 'text') {
      blocks.push({ kind: 'text', text: String(block.text ?? '') })
      continue
    }
    if (block?.type !== 'image') continue
    const admittedImage = admitted.images[imageIndex]
    imageIndex++
    if (deliver === 'metadata-only' || admittedImage === undefined) {
      const bytes = admittedImage === undefined ? 0 : Math.floor(admittedImage.data.length / 4) * 3
      const hash = admittedImage === undefined
        ? 'dropped'
        : createHash('sha256').update(admittedImage.data).digest('hex').slice(0, 16)
      blocks.push({
        kind: 'image-meta',
        mimeType: admittedImage?.mimeType ?? String(block.mimeType ?? 'image/png'),
        bytes,
        hash,
      })
      continue
    }
    const ref = refs[imageIndex - 1]
    blocks.push(ref === undefined
      ? { kind: 'text', text: `[image omitted: not stored]` }
      : { kind: 'image', attachment: ref })
  }
  if (admitted.dropped > 0) {
    blocks.push({ kind: 'text', text: `[${admitted.dropped} image(s) omitted: outside the admission budget]` })
  }
  if (blocks.length === 0) {
    // `content` is guaranteed but may be an empty array, and a schema-only server
    // can put its whole result in `structuredContent`. Falling back keeps a real
    // result visible instead of reporting "(no content)".
    if (envelope.structuredContent !== undefined) {
      blocks.push({ kind: 'text', text: JSON.stringify(envelope.structuredContent, null, 2) })
    } else {
      blocks.push({ kind: 'text', text: '(no content)' })
    }
  }
  return blocks
}

/**
 * The provider's `structuredContent`, verbatim, when the server sent one.
 *
 * The other half of the split documented above: `toResultBlocks` answers what a
 * model reads, this answers what a program reads. `Object.hasOwn` rather than a
 * truthiness test, so a server that deliberately sends `structuredContent: null`
 * is still reported as having sent it.
 */
export function providerStructuredContent(result: unknown): unknown {
  if (result === null || typeof result !== 'object') return undefined
  const envelope = result as { structuredContent?: unknown }
  return Object.hasOwn(envelope, 'structuredContent') ? envelope.structuredContent : undefined
}

function resolveCall(host: PtcHost, call: PtcProgramCall): { provider: ProviderConnection; operation: string } {
  const { provider: providerId, operation: operationName } = splitTarget(call.target)
  if (providerId === '' || operationName === undefined) {
    throw new Error(`target must be the qualified "provider.operation" (got ${JSON.stringify(call.target)})`)
  }
  const connection = host.providers().find(candidate => candidate.id === providerId)
  if (connection === undefined) {
    const known = host.providers().map(provider => provider.id)
    throw new Error(`unknown provider "${providerId}" in target "${call.target}"; known providers: ${known.join(', ') || 'none'}`)
  }
  const operation = connection.operations.find(candidate => candidate.name === operationName)
  if (operation === undefined) {
    throw new Error(`unknown operation "${call.target}"; available: ${connection.operations.map(candidate => candidate.name).join(', ') || 'none'}`)
  }
  const provided = (call.args ?? {}) as Record<string, unknown>
  const injected = Object.keys(host.spec(providerId)?.inject ?? {}).filter(key => Object.hasOwn(provided, key))
  if (injected.length > 0) {
    throw new Error(`${injected.join(', ')} ${injected.length === 1 ? 'is' : 'are'} host-owned: remove ${injected.length === 1 ? 'it' : 'them'} from args`)
  }
  return { provider: connection, operation: operationName }
}

/**
 * Run one batched program directly against providers (native presentation).
 * Calls run sequentially in the listed order; one failure stops the batch with
 * the failing call recorded and the error surfaced.
 */
export async function runDirect(host: PtcHost, request: PtcProgramRequest, signal?: AbortSignal): Promise<PtcProgramResult> {
  const clock = host.now ?? Date.now
  const started = clock()
  const calls: PtcCallResult[] = []
  for (const call of request.calls) {
    const callStarted = clock()
    try {
      const { provider, operation } = resolveCall(host, call)
      // Args go through VERBATIM. The connection owns injection and refuses a
      // caller-supplied host-owned key (`catalog.ts` `applyInjection`), so merging
      // `spec.inject` here as well made every injected provider fail with
      // "projectPath is host-owned and may not be supplied by the caller" — measured
      // 2026-10-12, kernel CLI ok / this CLI failed on the same spec. The kernel
      // passes args unchanged for exactly this reason (`bridge.ts:214`), and `inject`
      // appears nowhere else in that file. `resolveCall` above still refuses a
      // caller-supplied key early and with a clearer message.
      const provided = (call.args ?? {}) as Record<string, unknown>
      const result = await provider.call(operation, provided, signal)
      const blocks = await toResultBlocks(host, provider.id, operation, result, call.deliver ?? 'inline')
      const data = providerStructuredContent(result)
      calls.push({
        target: call.target,
        ...(call.title === undefined ? {} : { title: call.title }),
        ok: true,
        blocks,
        ...data === undefined ? {} : { data },
        durationMs: clock() - callStarted,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      calls.push({ target: call.target, ...(call.title === undefined ? {} : { title: call.title }), ok: false, blocks: [], error: message, durationMs: clock() - callStarted })
      return { ok: false, calls, error: message, durationMs: clock() - started }
    }
  }
  return { ok: true, calls, ...(request.returns === undefined ? {} : { value: request.returns }), durationMs: clock() - started }
}

/**
 * Render the TypeScript source a `ctx.ptcRuntime` run would execute for this
 * batch (PTC presentation). Each call becomes one `await tools.*` line so every
 * sub-call stays visible to the harness as `tool/ptc-dispatch`.
 */
export function buildProgram(request: PtcProgramRequest): string {
  const lines: string[] = []
  request.calls.forEach((call, index) => {
    const { provider, operation } = splitTarget(call.target)
    const varName = `r${index}`
    const args = JSON.stringify(call.args ?? {})
    const title = call.title ?? call.target
    lines.push(`// ${title}`)
    lines.push(`const ${varName} = await tools["${provider}.${operation}"](${args});`)
  })
  lines.push(request.returns === undefined
    ? `return { calls: ${request.calls.length} };`
    : request.returns)
  return lines.join('\n')
}
