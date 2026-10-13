/**
 * Assemble and run one batched PTC program.
 *
 * This file replaces `kernel.ts` + `bridge.ts` from node-repl-runtime. There is
 * no persistent kernel, no TCP bridge, no snapshot: the directory lives on the
 * host (`catalog.ts`), and each program run is one-shot — providers are called
 * directly, results are mapped to blocks, and nothing survives the run.
 *
 * Two execution paths exist, but only the first is wired today:
 *   - `runDirect` — call providers straight from the host (native presentation).
 *     Each `PtcProgramCall` becomes one provider call; `deliver` decides whether
 *     an image-bearing result enters the conversation or returns metadata only.
 *     **This is the path the mounted `cap_help`/`cap_call` face uses.**
 *   - `buildProgram` — render the program source a `ctx.ptcRuntime` run would
 *     execute (PTC presentation), keeping every sub-call visible to the harness
 *     as `tool/ptc-dispatch`. It has **no production caller**: it is the reserved
 *     second path, kept because the presentation work is planned (DESIGN §5.3
 *     `presentationMeta`) and the shape is already decided. Only `renderProgram`
 *     and the CLI reach it. Stated here so it does not read as live.
 */

import { hash as oneShotHash } from 'node:crypto'
import { collectProviderImages } from './catalog.js'
import type { ProviderImage } from './catalog.js'
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
 *
 * `imageOmission` is for a route that cannot receive images at all (a text-only
 * model). Every image block becomes that text and **nothing is written to the
 * attachment store**: delivering pixels only to rewrite the block afterwards
 * persisted images no model could ever read, and the store never deletes them
 * (measured: `saveImages` was still called once on a text-only route).
 */
export async function toResultBlocks(
  host: PtcHost,
  provider: string,
  operation: string,
  result: unknown,
  deliver: 'inline' | 'metadata-only',
  imageOmission?: string,
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
  // Source index -> position in `admitted.images`. The two counters differ the moment
  // admission refuses a block, so a position-based lookup would hand a refused block its
  // neighbour's image (measured: a dropped GIF received the admitted PNG's hash and, in
  // the inline arm, its attachment). Keyed by source index, every block resolves to its
  // own image or to none.
  const admittedByIndex = new Map<number, { image: ProviderImage; position: number }>()
  admitted.indexes.forEach((sourceIndex, position) => {
    const image = admitted.images[position]
    if (image !== undefined) admittedByIndex.set(sourceIndex, { image, position })
  })
  let refs: readonly PtcImageRef[] = []
  // Nothing is stored when the route refuses images outright: the pixels would be
  // written to a durable store that no model can read from and nothing prunes.
  const storesImages = imageOmission === undefined && deliver === 'inline' && host.saveImages !== undefined
  if (admitted.images.length > 0 && storesImages) {
    // A store failure degrades the image, it does not fail the call. The reply's
    // TEXT is the part the model came for — "Took a screenshot." or a provider's
    // error prose — and letting a storage fault throw here discarded all of it
    // (measured: "whole call failed, text LOST"). `refs` stays empty and each
    // admitted image becomes the "not stored" placeholder below instead.
    try {
      refs = await host.saveImages(admitted.images.map(image => ({
        data: Buffer.from(image.data, 'base64'),
        mediaType: image.mimeType,
        name: imageAttachmentName(image.mimeType),
      })))
    } catch {
      refs = []
    }
  }
  for (let index = 0; index < content.length; index++) {
    const block = content[index]
    if (block?.type === 'text') {
      blocks.push({ kind: 'text', text: String(block.text ?? '') })
      continue
    }
    if (block?.type !== 'image') continue
    if (imageOmission !== undefined) {
      // The refusal is decided by the route, before any work: report it for every
      // image block, including one admission would have refused anyway.
      blocks.push({ kind: 'text', text: `[image omitted: ${imageOmission}]` })
      continue
    }
    const admittedImage = admittedByIndex.get(index)
    if (deliver === 'metadata-only' || admittedImage === undefined) {
      const bytes = admittedImage === undefined ? 0 : Math.floor(admittedImage.image.data.length / 4) * 3
      // `crypto.hash` rather than `createHash().update().digest()`: byte-identical
      // output (verified on a 500 KB payload) for ~26% less time, and this is the
      // whole cost of a `metadata-only` screenshot — measured 1.795ms of which the
      // hash was 1.797ms, i.e. effectively all of it.
      const hash = admittedImage === undefined
        ? 'dropped'
        : oneShotHash('sha256', admittedImage.image.data, 'hex').slice(0, 16)
      blocks.push({
        kind: 'image-meta',
        mimeType: admittedImage?.image.mimeType ?? String(block.mimeType ?? 'image/png'),
        bytes,
        hash,
      })
      continue
    }
    const ref = refs[admittedImage.position]
    blocks.push(ref === undefined
      ? { kind: 'text', text: `[image omitted: not stored]` }
      : { kind: 'image', attachment: ref })
  }
  // Suppressed when the route refused images: every image was already reported as
  // omitted, so an admission-budget notice here would blame the wrong cause (the
  // budget had nothing to do with it) and report the same images twice.
  if (admitted.dropped > 0 && imageOmission === undefined) {
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
 *
 * The value is NOT normalized here — use {@link toLosslessJson} before handing it
 * to a program, which is what both call paths do.
 */
export function providerStructuredContent(result: unknown): unknown {
  if (result === null || typeof result !== 'object') return undefined
  const envelope = result as { structuredContent?: unknown }
  return Object.hasOwn(envelope, 'structuredContent') ? envelope.structuredContent : undefined
}

/**
 * Coerce a provider value into something a program can receive losslessly.
 *
 * The value arrives verbatim from the server, and an MCP reply is JSON on the wire,
 * so `JSON.parse` can produce values the host's completion gate refuses: `1e999`
 * becomes `Infinity`, and `-0` keeps its sign bit. Either one fails the entire run
 * with `invalid-output: program completion must be lossless JSON`, turning a legal
 * server reply into a dead program. Normalizing here means the program gets the
 * data it asked for — with a non-finite number as `null`, which is what
 * `JSON.stringify` would have produced anyway — instead of nothing at all.
 *
 * Values JSON cannot represent at all (functions, symbols, bigints, cycles) are
 * dropped: an object property is omitted, an array hole becomes `null`. A value
 * that cannot survive is never allowed to take the run down with it.
 *
 * **Copy-on-write.** A reply that is already lossless — the overwhelmingly common
 * case, since it came through `JSON.parse` — is returned AS IS, because rebuilding
 * an identical graph was pure cost (measured on a 150 KB reply: 0.296ms copying
 * vs 0.126ms validating). The copy only happens on the path that has something to
 * fix, and `undefined` (an unusable value) is still distinguishable from a
 * legitimate `null` result.
 */
export function toLosslessJson(value: unknown): unknown {
  return normalizeLossless(value, new Set())
}

/**
 * `undefined` means "this value cannot be represented"; callers drop the branch.
 *
 * Distinct from a returned `null`, which is a representable value. The set tracks
 * the current path only (added on entry, deleted on exit), so a shared sub-object
 * appearing twice as a sibling is not mistaken for a cycle.
 */
function normalizeLossless(value: unknown, ancestors: Set<object>): unknown {
  if (value === null) return null
  const type = typeof value
  if (type === 'string' || type === 'boolean') return value
  if (type === 'number') {
    const number = value as number
    if (!Number.isFinite(number)) return null
    return Object.is(number, -0) ? 0 : number
  }
  if (type !== 'object') return undefined
  if (ancestors.has(value as object)) return undefined
  const isArray = Array.isArray(value)
  const prototype = isArray ? Array.prototype : Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) {
    // Not reachable from parsed JSON, but a hand-built envelope can carry one:
    // represent it through its own `toJSON` (a Date) or drop the branch.
    const toJSON = (value as { toJSON?: () => unknown }).toJSON
    if (typeof toJSON !== 'function') return undefined
    ancestors.add(value as object)
    try {
      return normalizeLossless(toJSON.call(value), ancestors)
    } finally {
      ancestors.delete(value as object)
    }
  }

  ancestors.add(value as object)
  try {
    // Pass 1 — decide whether anything at all needs rewriting. Stops at the first
    // offending entry, so the common all-clean case costs one traversal and no
    // allocation.
    if (isLosslessShape(value as Record<string, unknown> | unknown[], isArray, ancestors)) return value

    // Pass 2 — rebuild only what must change. Values that are already clean are
    // copied by reference, so the rebuild is shallow wherever it can be.
    if (Array.isArray(value)) {
      const items: unknown[] = []
      for (let index = 0; index < value.length; index++) {
        const held = index in value ? value[index] : undefined
        const item = normalizeLossless(held, ancestors)
        items.push(item === undefined ? null : item)
      }
      return items
    }
    const plain: Record<string, unknown> = {}
    for (const [key, held] of Object.entries(value as Record<string, unknown>)) {
      const item = normalizeLossless(held, ancestors)
      if (item !== undefined) plain[key] = item
    }
    return plain
  } finally {
    ancestors.delete(value as object)
  }
}

/**
 * Whether every entry of an object/array is already losslessly representable.
 *
 * `true` means no rewrite is needed; `false` means pass 2 must rebuild. Returns as
 * soon as it finds one offending entry.
 */
function isLosslessShape(value: Record<string, unknown> | unknown[], isArray: boolean, ancestors: Set<object>): boolean {
  if (isArray) {
    const items = value as unknown[]
    for (let index = 0; index < items.length; index++) {
      if (!(index in items)) return false
      if (!isLosslessValue(items[index], ancestors)) return false
    }
    return true
  }
  for (const held of Object.values(value as Record<string, unknown>)) {
    if (held === undefined) return false
    if (!isLosslessValue(held, ancestors)) return false
  }
  return true
}

/** One value's own shape, descending only into containers. */
function isLosslessValue(value: unknown, ancestors: Set<object>): boolean {
  if (value === null) return true
  const type = typeof value
  if (type === 'string' || type === 'boolean') return true
  if (type === 'number') {
    const number = value as number
    return Number.isFinite(number) && !Object.is(number, -0)
  }
  if (type !== 'object') return false
  if (ancestors.has(value as object)) return false
  const isArray = Array.isArray(value)
  const prototype = isArray ? Array.prototype : Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) {
    // A `toJSON` carrier (a Date) CAN be represented — but only by rewriting it, so
    // it must report "needs work" here. Returning true left the Date object in
    // place, which the host gate then rejected as a non-plain object (caught by the
    // Date case in tests/lossless-copy.test.ts).
    return false
  }
  ancestors.add(value as object)
  try {
    return isLosslessShape(value as Record<string, unknown> | unknown[], isArray, ancestors)
  } finally {
    ancestors.delete(value as object)
  }
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
      // Normalized, not verbatim: see `toLosslessJson`. A server's `1e999` would
      // otherwise reach the host gate as `Infinity` and fail the whole run.
      const data = toLosslessJson(providerStructuredContent(result))
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
 *
 * Reserved path, not wired: nothing in the mounted face calls this today (see the
 * file header). Kept because the presentation work is planned and the rendering
 * shape is settled; `packages/runtime/src/index.ts` exposes it as
 * `renderProgram`.
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
