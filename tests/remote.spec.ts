import { describe, expect, it, vi } from 'vitest'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { ActivityInboxSnapshot } from '../src/contracts.js'
import {
  createActivityInboxSource,
  createConnectionActivityInboxTransport,
  type ActivityInboxTransport,
} from '../src/client/source.js'
import {
  ACTIVITY_INBOX_REMOTE_CONTRIBUTION,
  ACTIVITY_INBOX_REMOTE_NAMESPACE,
  ACTIVITY_INBOX_REMOTE_SERVICE,
} from '../src/remote.js'

function snapshot(revision = 1): ActivityInboxSnapshot {
  return {
    version: 1,
    revision,
    backfillReady: true,
    backfillFailures: 0,
    activities: [],
    preferences: [],
    presence: {
      version: 1,
      instanceId: 'host-1',
      revision,
      generatedAt: 1_000,
      ready: true,
      backfillFailures: 0,
      activities: [],
    },
  }
}

describe('Harness transport compatibility', () => {
  it('describes strict snapshot and mutation Remote methods', () => {
    const [read, mutate, petControl] = ACTIVITY_INBOX_REMOTE_CONTRIBUTION.descriptors
    expect(read).toMatchObject({
      service: ACTIVITY_INBOX_REMOTE_SERVICE,
      namespace: ACTIVITY_INBOX_REMOTE_NAMESPACE,
      method: 'snapshot',
      parameters: [],
    })
    expect(mutate).toMatchObject({
      service: ACTIVITY_INBOX_REMOTE_SERVICE,
      namespace: ACTIVITY_INBOX_REMOTE_NAMESPACE,
      method: 'mutate',
    })
    expect(petControl).toMatchObject({
      service: ACTIVITY_INBOX_REMOTE_SERVICE,
      namespace: ACTIVITY_INBOX_REMOTE_NAMESPACE,
      method: 'petControl',
    })
    expect(() => mutate.parameters[0].codec.schema.parse({ action: 'archive' })).toThrow()
    expect(mutate.parameters[0].codec.schema.parse({
      action: 'archive', sessionId: 'session-1', sourceSeq: 4,
    })).toEqual({ action: 'archive', sessionId: 'session-1', sourceSeq: 4 })
    expect(() => petControl.parameters[0].codec.schema.parse({ action: 'launch' })).toThrow()
    expect(petControl.parameters[0].codec.schema.parse({ action: 'start' })).toEqual({ action: 'start' })
    expect(() => read.result.schema.parse({ version: 1, activities: [] })).toThrow()
    expect(read.result.schema.parse(snapshot())).toEqual(snapshot())
    expect(() => read.result.schema.parse({
      ...snapshot(),
      presence: { ...snapshot().presence, instanceId: '', revision: -1 },
    })).toThrow()
  })

  it('drives the observable through the Remote-shaped transport', async () => {
    const transport: ActivityInboxTransport = {
      snapshot: vi.fn(async () => ({ ok: true, value: snapshot(2) })),
      mutate: vi.fn(async () => ({ ok: true, value: snapshot(3) })),
      petControl: vi.fn(async () => ({ ok: true, value: snapshot(4) })),
    }
    const source = createActivityInboxSource(transport, error => { throw error })

    source.refresh()
    await vi.waitFor(() => { expect(source.getSnapshot().server?.revision).toBe(2) })
    await expect(source.mutate({ action: 'unsnooze', sessionId: 'session-1' })).resolves.toEqual({ ok: true })
    expect(source.getSnapshot().server?.revision).toBe(3)
    await expect(source.controlPet({ action: 'start' })).resolves.toEqual({ ok: true })
    expect(source.getSnapshot().server?.revision).toBe(4)
  })

  it('retains the legacy channel adapter for rc.2 profiles', async () => {
    const call = vi.fn(async () => ({ ok: true as const, value: snapshot() }))
    const connection = { rpc: { call } } as unknown as ConnectionHandle
    const transport = createConnectionActivityInboxTransport(connection)

    await transport.snapshot()
    await transport.mutate({ action: 'unsnooze', sessionId: 'session-1' })
    await transport.petControl({ action: 'stop' })
    expect(call).toHaveBeenNthCalledWith(1, '/activity-inbox', 'snapshot', {})
    expect(call).toHaveBeenNthCalledWith(2, '/activity-inbox', 'mutate', {
      action: 'unsnooze', sessionId: 'session-1',
    })
    expect(call).toHaveBeenNthCalledWith(3, '/activity-inbox', 'pet-control', {
      action: 'stop',
    })
  })
})
