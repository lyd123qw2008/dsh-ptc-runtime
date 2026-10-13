import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.js'
import type { PtcCapabilityRuntimeLike } from '../src/index.js'

// A hermetic runtime whose connections record their own lifecycle, so a test can
// tell "the catalog still lists it" apart from "it still works".

interface FakeConnection {
  readonly id: string
  readonly label: string
  readonly operations: readonly { name: string; summary: string; safety: 'read'; inputSchema: Record<string, unknown> }[]
  call(operation: string): Promise<unknown>
  close(): Promise<void>
}

function fakeCtx() {
  const registered: { name: string; execute: (args: any, exec: any) => Promise<any> }[] = []
  let effectCleanup: (() => void) | undefined
  return {
    registered,
    runEffect: () => { effectCleanup?.() },
    ctx: {
      get: () => undefined,
      effect: (callback: () => () => void) => { effectCleanup = callback() },
      tools: { register(definition: any) { registered.push(definition); return () => {} } },
    },
  }
}

function runtimeFactoryOf(log: string[]) {
  let generation = 0
  return async (): Promise<PtcCapabilityRuntimeLike> => {
    const current = ++generation
    let closed = false
    const connection: FakeConnection = {
      id: 'p',
      label: 'fixture',
      operations: [{ name: 'ping', summary: '', safety: 'read', inputSchema: { type: 'object', properties: {} } }],
      call: async () => {
        if (closed) throw new Error(`provider p has no open session (generation ${current})`)
        return { content: [{ type: 'text', text: `gen${current}` }] }
      },
      close: async () => { closed = true },
    }
    return {
      catalog: () => [connection],
      failures: () => [],
      dispose: async () => {
        log.push(`dispose:${current}`)
        await connection.close()
      },
    }
  }
}

const toolOf = (ctx: ReturnType<typeof fakeCtx>, name: string) => {
  const tool = ctx.registered.find(candidate => candidate.name === name)
  if (tool === undefined) throw new Error(`tool ${name} was not registered`)
  return tool
}

describe('cap_help({refresh:true})', () => {
  it('leaves the adopted provider callable', async () => {
    const log: string[] = []
    const ctx = fakeCtx()
    await apply(ctx.ctx as never, {
      providers: [{ id: 'p', transport: 'stdio', command: 'node' }],
      runtimeFactory: runtimeFactoryOf(log),
    } as never)

    const help = toolOf(ctx, 'cap_help')
    const call = toolOf(ctx, 'cap_call')

    const before = await call.execute({ target: 'p.ping' }, {})
    expect(before.blocks[0].text).toBe('gen1')

    log.length = 0
    await help.execute({ refresh: true }, {})

    // The whole point of the bug: the catalog listed `p` while every call failed
    // with "has no open session", because the rebuilt runtime was disposed after
    // its connections had been adopted.
    const after = await call.execute({ target: 'p.ping' }, {})
    expect(after.blocks[0].text).toBe('gen2')
    // The OUTGOING runtime is the one reaped, not the incoming one.
    expect(log).toContain('dispose:1')
    expect(log).not.toContain('dispose:2')
  })

  it('survives repeated refreshes', async () => {
    const log: string[] = []
    const ctx = fakeCtx()
    await apply(ctx.ctx as never, {
      providers: [{ id: 'p', transport: 'stdio', command: 'node' }],
      runtimeFactory: runtimeFactoryOf(log),
    } as never)

    const help = toolOf(ctx, 'cap_help')
    const call = toolOf(ctx, 'cap_call')
    await help.execute({ refresh: true }, {})
    await help.execute({ refresh: true }, {})
    const after = await call.execute({ target: 'p.ping' }, {})
    expect(after.blocks[0].text).toBe('gen3')
  })

  it('still lists providers and their operations after a refresh', async () => {
    const log: string[] = []
    const ctx = fakeCtx()
    await apply(ctx.ctx as never, {
      providers: [{ id: 'p', transport: 'stdio', command: 'node' }],
      runtimeFactory: runtimeFactoryOf(log),
    } as never)

    const help = toolOf(ctx, 'cap_help')
    await help.execute({ refresh: true }, {})
    const catalog = await help.execute({}, {})
    expect(catalog.providers.map((provider: { id: string }) => provider.id)).toEqual(['p'])
    const operations = await help.execute({ target: 'p' }, {})
    expect(operations.operations.map((operation: { name: string }) => operation.name)).toEqual(['ping'])
  })
})

describe('unmount', () => {
  it('closes provider sessions when the plugin is disposed', async () => {
    const log: string[] = []
    const ctx = fakeCtx()
    await apply(ctx.ctx as never, {
      providers: [{ id: 'p', transport: 'stdio', command: 'node' }],
      runtimeFactory: runtimeFactoryOf(log),
    } as never)

    expect(log).toEqual([])
    ctx.runEffect()
    // Without this a stdio provider keeps its child process alive after unmount.
    expect(log).toContain('dispose:1')
  })

  it('closes the CURRENT runtime after a refresh, not the retired one twice', async () => {
    const log: string[] = []
    const ctx = fakeCtx()
    await apply(ctx.ctx as never, {
      providers: [{ id: 'p', transport: 'stdio', command: 'node' }],
      runtimeFactory: runtimeFactoryOf(log),
    } as never)

    const help = toolOf(ctx, 'cap_help')
    await help.execute({ refresh: true }, {})
    log.length = 0
    ctx.runEffect()
    expect(log).toEqual(['dispose:2'])
  })
})
