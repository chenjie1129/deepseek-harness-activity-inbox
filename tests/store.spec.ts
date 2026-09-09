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

function event(seq: number, type: SessionEvent['type'], data: unknown): SessionEvent {
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

  it('projects the complete live Presence lifecycle from Host events', async () => {
    const store = await storeFixture()
    const meta = header('task-live')
    store.markBackfillComplete(0)
    store.ingestEvent(meta, event(0, 'turn/start', { turn: 1 }))
    expect(store.snapshot().presence?.activities[0]).toMatchObject({
      sessionId: 'task-live', state: 'running', running: true, sourceSeq: 0,
    })

    store.ingestEvent(meta, event(1, 'tool/call', {
      turn: 1,
      step: 1,
      callId: 'question-1',
      name: 'ask_user_question',
      arguments: JSON.stringify({
        questions: [{
          id: 'plan',
          question: 'Approve?',
          detail: '# Plan',
          options: [{ label: 'Approve' }],
          intent: { kind: 'plan-review', approve: 'Approve' },
        }],
      }),
    }))
    expect(store.snapshot().presence?.activities[0]).toMatchObject({
      state: 'needs-input',
      pendingKind: 'plan-review',
      detail: 'Waiting for your plan review',
      sourceSeq: 1,
    })

    store.ingestEvent(meta, event(2, 'tool/result', {
      turn: 1,
      step: 1,
      message: { source: { kind: 'tool', callId: 'question-1' } },
    }))
    expect(store.snapshot().presence?.activities[0]).toMatchObject({
      state: 'running', running: true,
    })

    store.ingestEvent(meta, event(3, 'turn/end', {
      turn: 1,
      reason: { kind: 'completed' },
    }))
    expect(store.snapshot().presence?.activities[0]).toMatchObject({
      state: 'ready',
      terminalOutcome: 'completed',
      running: false,
      sourceSeq: 3,
    })
  })

  it('tracks approval waits without taking ownership and clears them by identity', async () => {
    const store = await storeFixture()
    store.beginPending('task-approval', 'a:call-1', 'approval', 2_000)
    expect(store.snapshot().presence?.activities[0]).toMatchObject({
      state: 'needs-input',
      pendingKind: 'approval',
      sourceSeq: -1,
    })

    const revision = store.snapshot().presence?.revision
    store.beginPending('task-approval', 'a:call-1', 'approval', 3_000)
    expect(store.snapshot().presence?.revision).toBe(revision)
    store.endPending('task-approval', 'a:call-1')
    expect(store.snapshot().presence?.activities).toEqual([])
  })

  it('uses the running-turn watermark to re-arm approval after an older snooze', async () => {
    const store = await storeFixture()
    const meta = header('task-rearmed')
    store.ingestEvent(meta, event(2, 'turn/end', { turn: 1, reason: { kind: 'failed' } }))
    await store.mutate({
      action: 'snooze',
      sessionId: 'task-rearmed',
      sourceSeq: 2,
      until: Date.now() + 60_000,
    })

    store.ingestEvent(meta, event(3, 'turn/start', { turn: 2 }))
    store.beginPending('task-rearmed', 'a:call-2', 'approval', 2_000)
    expect(store.snapshot().presence?.activities[0]).toMatchObject({
      state: 'needs-input',
      sourceSeq: 3,
    })
    expect(store.snapshot().presence?.activities[0]?.snoozedUntil).toBeUndefined()
  })

  it('does not resurrect an unfinished historical turn as live running work', async () => {
    const store = await storeFixture()
    store.ingest(header('stale-task'), [
      event(0, 'turn/start', { turn: 1 }),
      event(1, 'tool/call', {
        turn: 1, step: 1, callId: 'old-question',
        name: 'ask_user_question', arguments: '{"questions":[]}',
      }),
    ])
    expect(store.snapshot().presence?.activities).toEqual([])
  })

  it('notifies Presence subscribers only for revisions after subscription', async () => {
    const store = await storeFixture()
    const revisions: number[] = []
    const unsubscribe = store.subscribePresence(snapshot => {
      revisions.push(snapshot.revision)
    })

    store.noteSession(header('task-subscriber'))
    store.noteSession(header('task-subscriber'))
    store.beginPending('task-subscriber', 'a:approval', 'approval')
    unsubscribe()
    store.endPending('task-subscriber', 'a:approval')

    expect(revisions).toEqual([1, 2])
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
    expect(store.snapshot().presence?.activities[0]).toMatchObject({
      sessionId: 'task-2',
      state: 'ready',
      followed: true,
      reviewed: true,
      archived: true,
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
