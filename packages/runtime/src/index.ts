/**
 * The runtime facade: the catalog plus one-shot PTC program execution.
 *
 * Mirrors `node-repl-runtime/packages/runtime/src/index.ts` in shape:
 * `createCapabilityRuntime` attaches providers (concurrently, empty catalog
 * valid, failures non-fatal), and returns the host handle. The difference is
 * what the handle does: instead of `js`/`jsReset` on a persistent kernel, it
 * offers `runProgram` (direct provider calls, native presentation) and
 * `buildProgram` (rendered source for a `ctx.ptcRuntime` run).
 */

import { connectMcpProvider, describeProviderError, unattachedHealth } from './catalog.js'
import { buildProgram, runDirect } from './ptc.js'
import type {
  McpProviderSpec,
  ProviderConnection,
  ProviderFailure,
  PtcProgramRequest,
  PtcProgramResult,
  RuntimeOptions,
  UnattachedProvider,
} from './types.js'

export * from './types.js'
export {
  applyInjection,
  classifySessionLoss,
  collectProviderImages,
  connectMcpProvider,
  describeProviderError,
  isSessionLoss,
  isLateProgressNotification,
  projectOperation,
  providerHealth,
  selectTools,
  unattachedHealth,
  PROVIDER_IMAGE_MAX_BYTES,
  PROVIDER_IMAGE_TOTAL_MAX_BYTES,
  type ProviderImage,
  type ProviderImages,
} from './catalog.js'
export { buildProgram, providerStructuredContent, runDirect, splitBatchTarget, splitTarget, toLosslessJson, toResultBlocks, MAX_BATCH_TARGETS } from './ptc.js'
export type { PtcHost } from './ptc.js'

export interface PtcCapabilityRuntime {
  /** Run one batched program directly against providers. */
  runProgram(request: PtcProgramRequest, signal?: AbortSignal): Promise<PtcProgramResult>
  /** Render the program source a `ctx.ptcRuntime` run would execute. */
  renderProgram(request: PtcProgramRequest): string
  /** The projected catalog, for host-side reporting (not a model-facing tool). */
  catalog(): readonly ProviderConnection[]
  /** Providers that could not be attached, with their reasons. */
  failures(): readonly ProviderFailure[]
  dispose(): Promise<void>
}

export async function createCapabilityRuntime(options: RuntimeOptions): Promise<PtcCapabilityRuntime> {
  const connector = options.connector ?? connectMcpProvider
  const providers = new Map<string, ProviderConnection>()
  const unattached = new Map<string, { spec: McpProviderSpec; error: string }>()

  const connect = async (spec: McpProviderSpec): Promise<ProviderConnection> => {
    const connection = await connector(spec)
    providers.set(spec.id, connection)
    unattached.delete(spec.id)
    return connection
  }

  // No per-provider `attach` here, though the kernel runtime has one. There it is consumed by the
  // bridge, so a model can bring up a single provider that failed at startup (or move its URL)
  // without disturbing the others. The PTC face exposes no such verb: recovery is
  // `cap_help({refresh:true})`, which rebuilds every provider. Keeping a ported `attach` that
  // nothing calls — it was referenced only by a `void attach` — reads as a capability that exists.
  await Promise.all(options.providers.map(async (spec) => {
    if (spec.disabled === true) return
    try {
      await connect(spec)
    } catch (error) {
      const message = describeProviderError(error)
      unattached.set(spec.id, { spec, error: message })
      console.warn(`[dsh-ptc-runtime] provider ${spec.id} failed to connect: ${message}`)
    }
  }))

  const configuredOrder = new Map(options.providers.map((spec, index) => [spec.id, index]))
  const unattachedProviders = (): readonly UnattachedProvider[] => [...unattached.values()]
    .sort((left, right) =>
      (configuredOrder.get(left.spec.id) ?? 0) - (configuredOrder.get(right.spec.id) ?? 0))
    .map(entry => ({
      failure: { id: entry.spec.id, error: entry.error },
      health: unattachedHealth(entry.spec, entry.error),
    }))

  const specs = new Map(options.providers.map(spec => [spec.id, spec]))
  const host = {
    providers: () => [...providers.values()],
    spec: (id: string) => specs.get(id),
  }

  let disposed = false
  return {
    runProgram: (request, signal) => runDirect(host, request, signal),
    renderProgram: (request) => buildProgram(request),
    catalog: () => [...providers.values()],
    failures: () => unattachedProviders().map(entry => entry.failure),
    async dispose() {
      if (disposed) return
      disposed = true
      for (const provider of providers.values()) await provider.close().catch(() => {})
    },
  }
}

/** Human-readable connection report: what attached, and what did not with its reason. */
export function describeProviders(
  providers: readonly ProviderConnection[],
  failures: readonly ProviderFailure[] = [],
): string {
  return [
    ...providers.map(provider => `${provider.id} (${provider.label}) — ${provider.operations.length} operation(s)`),
    ...failures.map(failure => `${failure.id} — NOT ATTACHED: ${failure.error}`),
  ].join('\n')
}

export type { McpProviderSpec, ProviderConnection }
