import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import type { ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { observeApprovalPresence } from '../src/presence/approval.js'
import { ActivityInboxStore } from '../src/store.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<ActivityInboxStore> {
  const root = await mkdtemp(join(tmpdir(), 'activity-presence-approval-'))
  roots.push(root)
  const store = new ActivityInboxStore(join(root, 'state.json'))
  await store.initialize()
  return store
}

function request(): ApprovalRequest {
  return {
    agent: { id: 'approval-task' },
    toolName: 'bash',
    callId: 'call-1',
  } as unknown as ApprovalRequest
}

describe('approval Presence observer', () => {
  it('exposes the wait while preserving the downstream outcome', async () => {
    const store = await fixture()
    let resolveDownstream!: (value: 'allowed-once') => void
    const downstream = new Promise<'allowed-once'>(resolve => { resolveDownstream = resolve })
    const result = observeApprovalPresence(store, request(), () => downstream)

    expect(store.snapshot().presence?.activities[0]).toMatchObject({
      sessionId: 'approval-task',
      state: 'needs-input',
      pendingKind: 'approval',
    })
    resolveDownstream('allowed-once')
    await expect(result).resolves.toBe('allowed-once')
    expect(store.snapshot().presence?.activities).toEqual([])
  })

  it('clears the wait when the downstream answerer rejects', async () => {
    const store = await fixture()
    const failure = new Error('answerer failed')
    await expect(observeApprovalPresence(
      store,
      request(),
      () => Promise.reject(failure),
    )).rejects.toBe(failure)
    expect(store.snapshot().presence?.activities).toEqual([])
  })
})
