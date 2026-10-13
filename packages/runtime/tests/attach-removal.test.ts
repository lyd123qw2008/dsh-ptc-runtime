import { describe, expect, it, vi } from 'vitest'
import { createCapabilityRuntime } from '../src/index.js'
import type { ProviderConnection } from '../src/types.js'

const connection = (id: string): ProviderConnection => ({
  id,
  label: id,
  operations: [],
  call: async () => ({ content: [] }),
  close: async () => {},
})

describe('disabled providers after the attach removal', () => {
  it('does not connect a disabled provider', async () => {
    const connector = vi.fn(async (spec: { id: string }) => connection(spec.id))
    const runtime = await createCapabilityRuntime({
      providers: [
        { id: 'on', transport: 'stdio', command: 'node' },
        { id: 'off', transport: 'stdio', command: 'node', disabled: true },
      ],
      connector,
    })
    expect(runtime.catalog().map(provider => provider.id)).toEqual(['on'])
    expect(connector).toHaveBeenCalledTimes(1)
    // A disabled provider is not a FAILURE: it was switched off on purpose.
    expect(runtime.failures()).toEqual([])
    await runtime.dispose()
  })

  it('reports a genuine connect failure without letting it be fatal', async () => {
    const connector = async (spec: { id: string }): Promise<ProviderConnection> => {
      if (spec.id === 'bad') throw new Error('no such command')
      return connection(spec.id)
    }
    const runtime = await createCapabilityRuntime({
      providers: [
        { id: 'good', transport: 'stdio', command: 'node' },
        { id: 'bad', transport: 'stdio', command: 'nope' },
      ],
      connector,
    })
    expect(runtime.catalog().map(provider => provider.id)).toEqual(['good'])
    expect(runtime.failures().map(failure => failure.id)).toEqual(['bad'])
    expect(runtime.failures()[0]!.error).toContain('no such command')
    await runtime.dispose()
  })

  it('still disposes every live provider', async () => {
    const closed: string[] = []
    const connector = async (spec: { id: string }): Promise<ProviderConnection> => ({
      ...connection(spec.id),
      close: async () => { closed.push(spec.id) },
    })
    const runtime = await createCapabilityRuntime({
      providers: [
        { id: 'a', transport: 'stdio', command: 'node' },
        { id: 'b', transport: 'stdio', command: 'node' },
      ],
      connector,
    })
    await runtime.dispose()
    expect(closed.sort()).toEqual(['a', 'b'])
  })
})
