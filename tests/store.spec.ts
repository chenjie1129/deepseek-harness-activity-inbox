import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { ActivityInboxStore } from '../src/store.js'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function storeFixture(): Promise<ActivityInboxStore> {
  const root = await mkdtemp(join(tmpdir(), 'activity-inbox-'))
  temporaryRoots.push(root)
  const store = new ActivityInboxStore(join(root, 'state.json'))
  await store.initialize()
  return store
}

function header(id: string, parent?: string): SessionHeader {
  return {
    version: 0,
    id: SessionId(id),
    createdAt: 1,
    ...parent === undefined ? {} : {
      parentSession: SessionId(parent),
      origin: 'subagent' as const,
      delegationDepth: 1,
    },
  }
}

function event(seq: number, type: 'turn/start' | 'turn/end', data: unknown): SessionEvent {
  return { type, seq, time: 1_000 + seq, data } as SessionEvent
}

describe('ActivityInboxStore event fold', () => {
  it('classifies terminal outcomes without treating cancellation as failure', async () => {
    const store = await storeFixture()
    const meta = header('task-1')
    store.ingestEvent(meta, event(0, 'turn/start', { turn: 1 }))
    store.ingestEvent(meta, event(1, 'turn/end', { turn: 1, reason: { kind: 'completed' } }))
    expect(store.snapshot().activities[0]).toMatchObject({
      sessionId: 'task-1', seq: 1, outcome: 'completed', reasonCode: 'completed',
    })

    store.ingestEvent(meta, event(2, 'turn/start', { turn: 2 }))
    expect(store.snapshot().activities).toEqual([])
    store.ingestEvent(meta, event(3, 'turn/end', {
      turn: 2, reason: { kind: 'error', error: { message: 'provider unavailable', code: 'UNKNOWN' } },
    }))
    expect(store.snapshot().activities[0]).toMatchObject({
      seq: 3, outcome: 'failed', detail: 'provider unavailable',
    })

    store.ingestEvent(meta, event(4, 'turn/start', { turn: 3 }))
    store.ingestEvent(meta, event(5, 'turn/end', {
      turn: 3, reason: { kind: 'aborted', reason: { kind: 'user' } },
    }))
    expect(store.snapshot().activities).toEqual([])
  })

  it('keeps the newest live outcome when an older backfill arrives later', async () => {
    const store = await storeFixture()
    const meta = header('child-1', 'parent-1')
    store.ingestEvent(meta, event(9, 'turn/end', { turn: 3, reason: { kind: 'blocked' } }))
    store.ingest(meta, [
      event(0, 'turn/start', { turn: 1 }),
      event(1, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ])
    expect(store.snapshot().activities[0]).toMatchObject({
      sessionId: 'child-1', seq: 9, outcome: 'blocked', parentSessionId: 'parent-1', origin: 'subagent',
    })
  })
})

describe('ActivityInboxStore preferences', () => {
  it('persists review, follow, snooze, and archive state after the write resolves', async () => {
    const store = await storeFixture()
    const meta = header('task-2')
    store.ingestEvent(meta, event(4, 'turn/end', { turn: 1, reason: { kind: 'completed' } }))
    await store.mutate({ action: 'set-followed', sessionId: 'task-2', followed: true })
    await store.mutate({ action: 'mark-reviewed', sessionId: 'task-2', sourceSeq: 4 })
    await store.mutate({ action: 'snooze', sessionId: 'task-2', sourceSeq: 4, until: Date.now() + 60_000 })
    await store.mutate({ action: 'archive', sessionId: 'task-2', sourceSeq: 4 })

    const raw = JSON.parse(await readFile(store.statePath, 'utf8')) as { revision: number }
    expect(raw.revision).toBe(4)
    const restored = new ActivityInboxStore(store.statePath)
    await restored.initialize()
    expect(restored.snapshot().preferences[0]).toMatchObject({
      sessionId: 'task-2', followed: true, reviewedThroughSeq: 4, archivedThroughSeq: 4,
      snooze: { sourceSeq: 4 },
    })
  })

  it('rejects a stale activity mutation instead of marking a newer turn reviewed', async () => {
    const store = await storeFixture()
    const meta = header('task-3')
    store.ingestEvent(meta, event(1, 'turn/end', { turn: 1, reason: { kind: 'completed' } }))
    store.ingestEvent(meta, event(2, 'turn/start', { turn: 2 }))
    store.ingestEvent(meta, event(3, 'turn/end', { turn: 2, reason: { kind: 'max-tokens' } }))
    await expect(store.mutate({ action: 'mark-reviewed', sessionId: 'task-3', sourceSeq: 1 }))
      .rejects.toThrow('activity changed')
    expect(store.snapshot().preferences).toEqual([])
  })
})
