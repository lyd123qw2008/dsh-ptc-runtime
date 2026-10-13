/**
 * Public shapes for the PTC capability runtime. Deliberately small: everything
 * else is a provider's business.
 *
 * Mirrors `node-repl-runtime/packages/runtime/src/types.ts` field-for-field
 * where the shape is provider-related (`McpProviderSpec`, `ProjectedOperation`,
 * `ProviderHealth`, `ProviderConnection`, `ProviderFailure`, `UnattachedProvider`,
 * session-loss taxonomy). Kernel-only shapes (`JsCellBlock`, `JsCellResult`,
 * `JsOptions`, `CatalogEntry`, `InFlightCall`, kernel entry/command options)
 * are intentionally absent: there is no persistent kernel here, so nothing
 * crosses a bridge and nothing survives one run.
 *
 * New here: `PtcProgram*` — how one batched program is described to
 * `ctx.ptcRuntime`, and how its per-call results come back.
 *
 * @module @lyd123qw2008/dsh-ptc-runtime/src/types
 */

/**
 * One MCP server, as configuration. This is the entire integration surface — there
 * is no provider-specific code path anywhere in this package.
 */
export interface McpProviderSpec {
  /** Namespace the model uses: `cap_call({ target: '<id>.<operation>' })`. */
  readonly id: string
  readonly label?: string
  readonly transport: 'streamable-http' | 'stdio'
  /** Required for `streamable-http`. */
  readonly url?: string
  /** Required for `stdio`. */
  readonly command?: string
  readonly args?: readonly string[]
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string>>
  /** When true, skip this provider without starting or connecting its MCP server. */
  readonly disabled?: boolean
  /**
   * Host-owned constant arguments, added on the host side before the MCP call.
   *
   * These are removed from the model-visible input schema, and a caller that
   * supplies one anyway is refused rather than silently overridden — the model must
   * not be able to redirect a host decision like which project to act on.
   */
  readonly inject?: Readonly<Record<string, unknown>>
  /** Optional exposure narrowing: regular expressions matched against tool names. */
  readonly include?: readonly string[] | null
  /**
   * Budget for one call that reports no progress, in milliseconds. Default 300_000.
   *
   * A *quiet* call is what this bounds: the server's progress notifications renew the deadline, so
   * an operation that keeps reporting stays alive while one that goes silent for this long is
   * cancelled. It is not the real ceiling — the program's own budget aborts the call, and a hard
   * one-hour ceiling applies regardless.
   */
  readonly timeoutMs?: number
}

/** One operation as the model sees it: the provider's own tool, minus host-owned arguments. */
export interface ProjectedOperation {
  readonly name: string
  readonly summary: string
  /** Informational only. Derived from the server's own declaration; never a gate. */
  readonly safety: 'read' | 'mutate'
  readonly inputSchema: {
    readonly type: 'object'
    readonly properties: Readonly<Record<string, unknown>>
    readonly required: readonly string[]
    readonly additionalProperties: false
  }
  /**
   * The result shape, when the server declares one (`outputSchema`, MCP standard).
   *
   * Relayed verbatim and never interpreted. Without it a program author can only guess
   * whether a call returns `{items: [...]}`, `{files: [...]}`, or raw content blocks —
   * measured against the IDEA server, 42 of its 67 tools declare one, so dropping it
   * turns a declared contract into guesswork.
   */
  readonly outputSchema?: Readonly<Record<string, unknown>>
}

/**
 * Lifecycle state of one provider's MCP session, as the host sees it.
 *
 * It exists because a session can end without the connection noticing: a streamable-HTTP
 * server that restarts keeps its URL but forgets every session id it issued, and a stdio
 * child can die. Without a state to read, "this capability is broken" and "this capability
 * was never configured" look the same from a program.
 */
export interface ProviderHealth {
  readonly id: string
  readonly label: string
  readonly state: 'connected' | 'reconnecting' | 'failed'
  /**
   * False for a provider that is configured but never got connected in this process.
   *
   * The distinction `state: 'failed'` alone cannot make: "was attached and is currently down"
   * (retry the session) and "never attached" (connect it for the first time) are different
   * situations, and the second is the one a DSH started while the IDE was still closed leaves
   * behind. `reconnect` handles both; this field is how a caller tells which it is looking at.
   */
  readonly attached: boolean
  /**
   * False when the connection owns no session that could be re-opened — a host-supplied
   * connection, or one built directly for a test. Reported rather than guessed at, so
   * a reconnect can refuse honestly instead of pretending to have done something.
   */
  readonly reconnectable: boolean
  readonly operations: number
  /** Bumped on every successful (re)connect, so a stale catalog is detectable without diffing. */
  readonly generation: number
  /** Sessions rebuilt after this connection's first one. */
  readonly reconnects: number
  /** Why the last re-open failed. Kept rather than logged: the reason is the useful fact. */
  readonly lastError?: string
  /** The endpoint in use now, which a reconnect override may have changed. */
  readonly url?: string
}

export interface ProviderReconnectOptions {
  /**
   * Re-open against this endpoint instead of the spec's `url`.
   *
   * An IDE that picks a new port on restart would otherwise be unreachable for the life of
   * the host process, since provider specs are read once at startup.
   */
  readonly url?: string
}

/**
 * The re-openable half of a connection: what a long-lived client needs in order to survive
 * the server under it restarting.
 */
export interface ProviderSession {
  /** Live state, for a caller that wants to know before it calls. */
  health(): ProviderHealth
  /**
   * Discard the current session, open a new one, and refresh the projected catalog.
   *
   * Single-flight: concurrent callers share one attempt rather than racing to open several
   * sessions. Rejects — with the reason — when the server cannot be reached; the previous
   * failure is never reported as success.
   */
  reconnect(options?: ProviderReconnectOptions): Promise<ProviderHealth>
}

/**
 * A live connection to one MCP server, projected for the tools.
 *
 * `operations` is a getter on the real connection, not a snapshot: a session that had to be
 * rebuilt may be serving a different tool list, and a caller that cached the first one would
 * keep offering operations the server no longer has.
 *
 * `signal` is aborted when the tool call that asked for it can no longer read the answer,
 * so a request never outlives its caller.
 */
export interface ProviderConnection {
  readonly id: string
  readonly label: string
  readonly operations: readonly ProjectedOperation[]
  call(operation: string, args: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<unknown>
  /**
   * Absent for a connection with no session to lose.
   *
   * `connectMcpProvider` always provides it; the test seam (`RuntimeOptions.connector`) and any
   * host-supplied connection may not, and saying so by omission is more honest than a
   * `reconnect` that resolves without having reconnected anything.
   */
  readonly session?: ProviderSession
  close(): Promise<void>
}

/**
 * A provider that could not be attached, and the reason it gave.
 *
 * Kept rather than logged and forgotten: `cap_help` is the only place a model can ask why a
 * capability is missing, and a silent absence is indistinguishable from one that was never
 * configured — measured: a `cua` provider that failed to attach looked exactly like a `cua`
 * provider nobody had written down.
 */
export interface ProviderFailure {
  readonly id: string
  readonly error: string
}

/**
 * A configured provider that is not attached, in the two shapes discovery needs.
 *
 * One record rather than two parallel lists, because the reason a provider is missing and how
 * healthy it looks are the same fact: splitting them is how they end up disagreeing.
 */
export interface UnattachedProvider {
  readonly failure: ProviderFailure
  readonly health: ProviderHealth
}

/** How a failed call relates to the session, and whether a retry can be proved free of side effects. */
export type SessionLossKind = 'never-ran' | 'maybe-ran'

/**
 * One batched PTC program: what the model (or skill template) asks to run.
 *
 * A program is a straight-line list of provider calls plus a return expression source is
 * assembled by `ptc.ts` from these calls — the model never hand-writes orchestration
 * boilerplate. Each call keeps its own `title` so the transcript row says what the call
 * was *for*, and `deliver` decides whether an image-bearing result enters the conversation.
 */
export interface PtcProgramCall {
  /** Qualified `provider.operation`, exactly as `cap_help` lists it. */
  readonly target: string
  /** Arguments for the operation, exactly as its schema declares them. */
  readonly args?: Readonly<Record<string, unknown>>
  /** Display-only label for the transcript row. Never sent to the provider. */
  readonly title?: string
  /**
   * Image delivery: `inline` (default) lets an image-bearing result enter the
   * conversation; `metadata-only` returns sizes/hashes for aggregation without
   * delivering pixels. The file-argument detour is never needed.
   */
  readonly deliver?: 'inline' | 'metadata-only'
}

/** One program run request, as the tools hand it to the PTC executor. */
export interface PtcProgramRequest {
  readonly calls: readonly PtcProgramCall[]
  /** Source of the final aggregation expression, evaluated after all calls settle. */
  readonly returns?: string
  /** Display-only label for the whole program. */
  readonly title?: string
}

/** One settled call inside a program run. */
export interface PtcCallResult {
  readonly target: string
  readonly title?: string
  readonly ok: boolean
  /** Provider result blocks (text + committed image references), in server order. */
  readonly blocks: readonly PtcResultBlock[]
  /**
   * The provider's `structuredContent`, verbatim, when the server sent one.
   *
   * Separate from `blocks` on purpose, because they answer to different consumers:
   * `blocks` is what a MODEL reads (rendered from `content`, the protocol's
   * guaranteed channel), while this is what a PROGRAM reads. The kernel runtime
   * splits them the same way by handing its cell `structuredContent ?? content`
   * (`catalog.ts:655`); a face that carried only the rendered text would hand a
   * program a JSON string where the kernel handed it an object.
   */
  readonly data?: unknown
  readonly error?: string
  readonly durationMs: number
}

export type PtcResultBlock =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'image'; readonly attachment: PtcImageRef }
  | { readonly kind: 'image-meta'; readonly mimeType: string; readonly bytes: number; readonly hash: string }

/** Durable image reference, committed to the attachment store (content-addressed). */
export interface PtcImageRef {
  readonly attachmentId: string
  readonly mediaType: string
  readonly bytes: number
}

/** Outcome of one program run. */
export interface PtcProgramResult {
  readonly ok: boolean
  readonly calls: readonly PtcCallResult[]
  readonly value?: unknown
  readonly error?: string
  readonly durationMs: number
}

/** Test seam: swap the MCP connection out for a hermetic fake. */
export type ProviderConnector = (spec: McpProviderSpec) => Promise<ProviderConnection>

export interface RuntimeOptions {
  readonly providers: readonly McpProviderSpec[]
  /** Override the connection step (tests). */
  readonly connector?: ProviderConnector
}
