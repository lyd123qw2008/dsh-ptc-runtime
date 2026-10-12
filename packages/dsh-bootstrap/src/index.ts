/**
 * Mount the PTC capability runtime into a DSH profile from configuration alone.
 *
 * Mirrors `node-repl-runtime/packages/dsh-bootstrap/src/index.ts`: provider
 * configuration is machine-local, read from `config.providers`,
 * `PTC_CAP_PROVIDERS` (inline JSON), or `PTC_CAP_PROVIDERS_FILE`.
 *
 * An empty provider list is valid. Connection failures are non-fatal; failed
 * providers simply contribute no operations.
 */

import { readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import { createCapabilityRuntime, type McpProviderSpec, type ProviderConnection, type ProviderFailure, type RuntimeOptions } from '@lyd123qw2008/dsh-ptc-runtime'
import { createCapTools, type PtcCapHost } from '@lyd123qw2008/dsh-ptc-dsh-adapter'

// Type-only: load the `Context.attachments` / `Context.llm` augmentations the
// tools read. A deployment without either service still mounts — a call that
// would need images degrades to text and says so.
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-llm'

export const name = 'dsh-ptc-runtime-bootstrap'

/** Needs the tool registry; the attachment and llm services are optional by design. */
export const inject = ['tools'] as const

export interface PtcBootstrapConfig {
  readonly providers?: readonly McpProviderSpec[]
  /** Path to a JSON file holding the provider list (`[...]` or `{ "providers": [...] }`). */
  readonly providersFile?: string
  /** Default per-program budget. */
  readonly programTimeoutMs?: number
  /** Override runtime construction (tests). */
  readonly runtimeFactory?: (options: RuntimeOptions) => Promise<PtcCapabilityRuntimeLike>
}

export interface PtcCapabilityRuntimeLike {
  catalog(): readonly ProviderConnection[]
  failures(): readonly ProviderFailure[]
  dispose(): Promise<void>
}

interface ProviderFile {
  readonly providers?: readonly McpProviderSpec[]
}

export function resolveProviders(
  config: PtcBootstrapConfig,
  env: Readonly<Record<string, string | undefined>> = process.env,
): readonly McpProviderSpec[] {
  if (config.providers !== undefined) return config.providers

  const fromFile = (path: string): readonly McpProviderSpec[] => {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return Array.isArray(parsed) ? parsed as readonly McpProviderSpec[] : (parsed as ProviderFile).providers ?? []
  }

  if (config.providersFile !== undefined && config.providersFile.trim() !== '') {
    return fromFile(config.providersFile)
  }
  const inline = env.PTC_CAP_PROVIDERS
  if (inline !== undefined && inline.trim() !== '') {
    const parsed = JSON.parse(inline) as unknown
    return Array.isArray(parsed) ? parsed as readonly McpProviderSpec[] : (parsed as ProviderFile).providers ?? []
  }
  const file = env.PTC_CAP_PROVIDERS_FILE
  if (file !== undefined && file.trim() !== '') return fromFile(file)
  return []
}

export const apply = async (ctx: Context, config: PtcBootstrapConfig = {}): Promise<void> => {
  const providers = resolveProviders(config)
  const build = config.runtimeFactory ?? createCapabilityRuntime
  const runtime = await build({
    providers,
    ...config.programTimeoutMs === undefined ? {} : { programTimeoutMs: config.programTimeoutMs },
  })

  const host: PtcCapHost = {
    providers: () => runtime.catalog(),
    failures: () => runtime.failures(),
    spec: id => providers.find(candidate => candidate.id === id),
    // The runtime reconnects its own live sessions on demand, so a catalog read
    // needs a new handshake rather than a snapshot: what a model reads is what
    // the servers advertise now. In-flight calls do not survive this — documented.
    refresh: async () => {
      for (const connection of runtime.catalog()) await connection.close().catch(() => {})
      const rebuilt = await build({
        providers,
        ...config.programTimeoutMs === undefined ? {} : { programTimeoutMs: config.programTimeoutMs },
      })
      // Swap in the rebuilt catalog/failures; the old runtime stays open only to
      // release anything `close()` left behind.
      Object.assign(runtime, {
        catalog: rebuilt.catalog,
        failures: rebuilt.failures,
      })
      void rebuilt.dispose()
    },
    call: async (provider, operation, args, signal) => {
      const connection = runtime.catalog().find(candidate => candidate.id === provider)
      if (connection === undefined) throw new Error(`provider "${provider}" is not attached`)
      return await connection.call(operation, args, signal)
    },
    attachments: () => ctx.get('attachments'),
    llm: () => ctx.get('llm'),
  }

  const disposers = createCapTools(host).map(definition => ctx.tools.register(definition))
  ctx.effect(() => () => {
    for (const dispose of [...disposers].reverse()) dispose()
  }, 'dsh-ptc-runtime: unregister cap_help/cap_call')

  const report = runtime.catalog().map(provider => `${provider.id}=${provider.operations.length}`).join(' ') || 'no connected providers'
  const notAttached = runtime.failures().map(failure => failure.id)
  const disabled = providers.filter(spec => spec.disabled === true).map(spec => spec.id)
  console.log(
    `[dsh-ptc-runtime] mounted ${report}`
    + (disabled.length > 0 ? ` | disabled: ${disabled.join(',')}` : '')
    + (notAttached.length > 0 ? ` | not attached: ${notAttached.join(',')}` : ''),
  )
}
