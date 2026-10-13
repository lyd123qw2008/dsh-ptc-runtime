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
  // No program-timeout option here on purpose. In the kernel runtime the cell budget was this
  // layer's to own (`cellTimeoutMs` -> `defaultTimeoutMs`), but under PTC the deadline belongs to
  // DSH's `run_code` (`timeoutMs`, default 120s, capped by the deployment) and reaches the child
  // through `ctx.ptcRuntime`. A second budget here would be a knob that changed nothing — which is
  // exactly what the `programTimeoutMs` field this replaces had become.
  const buildOptions = () => ({ providers })
  // The live runtime, swapped by `refresh`. Held in a variable rather than read
  // through a fixed reference so an adoption changes what every host hook sees.
  let current = await build(buildOptions())

  const host: PtcCapHost = {
    providers: () => current.catalog(),
    failures: () => current.failures(),
    spec: id => providers.find(candidate => candidate.id === id),
    // The runtime reconnects its own live sessions on demand, so a catalog read
    // needs a new handshake rather than a snapshot: what a model reads is what
    // the servers advertise now. Rebuilding also retries providers that failed to
    // attach at mount, which is the only way `refresh` can pick one up. In-flight
    // calls do not survive this — documented.
    refresh: async () => {
      const previous = current
      const rebuilt = await build(buildOptions())
      // Adopt first, dispose second — and dispose the OUTGOING runtime, never the
      // incoming one. `catalog` closes over the runtime's own provider map, so
      // disposing the rebuilt runtime closes exactly the connections just adopted:
      // the catalog would still list every provider while every call failed with
      // "has no open session". Disposing `previous` instead reaps the sessions being
      // replaced (including stdio children) and leaves the new ones untouched.
      current = rebuilt
      await previous.dispose().catch(() => {})
    },
    call: async (provider, operation, args, signal) => {
      const connection = current.catalog().find(candidate => candidate.id === provider)
      if (connection === undefined) throw new Error(`provider "${provider}" is not attached`)
      return await connection.call(operation, args, signal)
    },
    attachments: () => ctx.get('attachments'),
    llm: () => ctx.get('llm'),
  }

  const disposers = createCapTools(host).map(definition => ctx.tools.register(definition))
  ctx.effect(() => () => {
    for (const dispose of [...disposers].reverse()) dispose()
    // Closing the sessions is the other half of unmounting: without it a stdio
    // provider keeps its child process running for the life of the host process.
    void current.dispose().catch(() => {})
  }, 'dsh-ptc-runtime: unregister cap_help/cap_call and close provider sessions')

  const report = current.catalog().map(provider => `${provider.id}=${provider.operations.length}`).join(' ') || 'no connected providers'
  const notAttached = current.failures().map(failure => failure.id)
  const disabled = providers.filter(spec => spec.disabled === true).map(spec => spec.id)
  console.log(
    `[dsh-ptc-runtime] mounted ${report}`
    + (disabled.length > 0 ? ` | disabled: ${disabled.join(',')}` : '')
    + (notAttached.length > 0 ? ` | not attached: ${notAttached.join(',')}` : ''),
  )
}
