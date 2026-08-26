import { describe, expect, it } from 'vitest'
import type { SessionId, SessionListState, SessionSummary } from '@deepseek-ai/dsh-client-runtime/client'
import type { ActivityInboxSnapshot } from '../src/contracts.js'
import { activityBadgeCount, deriveInboxRows, rowsForFilter } from '../src/client/model.js'

function id(value: string): SessionId {
  return value as SessionId
}

function summary(sessionId: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: id(sessionId),
    displayTitle: `Title ${sessionId}`,
    running: false,
    blank: false,
    updatedAt: 100,
    ...overrides,
  }
}

function sessionState(rows: SessionSummary[]): SessionListState {
  return {
    ids: rows.map(row => row.id),
    byId: Object.fromEntries(rows.map(row => [row.id, row])) as Record<SessionId, SessionSummary>,
    current: undefined,
    phase: 'ready',
    subagentsByParent: {},
    jobsBySession: {},
    currentAddress: undefined,
  }
}

function snapshot(overrides: Partial<ActivityInboxSnapshot> = {}): ActivityInboxSnapshot {
  return {
    version: 1,
    revision: 0,
    backfillReady: true,
    backfillFailures: 0,
    activities: [],
    preferences: [],
    ...overrides,
  }
}

describe('activity inbox view model', () => {
  it('prioritizes a live pending interaction over an older completion', () => {
    const rows = deriveInboxRows(snapshot({
      activities: [{
        sessionId: 'one', seq: 8, turn: 1, occurredAt: 90,
        outcome: 'completed', reasonCode: 'completed', detail: 'Turn completed',
      }],
    }), sessionState([summary('one', { pendingInteraction: 'approval' })]), 1_000)
    expect(rows[0]).toMatchObject({
      category: 'needs-action', pendingKind: 'approval', detail: 'Waiting for your approval', reviewed: false,
    })
    expect(activityBadgeCount(rows)).toBe(1)
  })

  it('removes reviewed failures from the badge but keeps them in the Failed view', () => {
    const rows = deriveInboxRows(snapshot({
      activities: [{
        sessionId: 'failed', seq: 5, turn: 2, occurredAt: 95,
        outcome: 'failed', reasonCode: 'error', detail: 'boom',
      }],
      preferences: [{ sessionId: 'failed', followed: false, reviewedThroughSeq: 5 }],
    }), sessionState([summary('failed')]), 1_000)
    expect(activityBadgeCount(rows)).toBe(0)
    expect(rowsForFilter(rows, 'failed')).toHaveLength(1)
    expect(rowsForFilter(rows, 'failed')[0]?.reviewed).toBe(true)
  })

  it('makes a new source sequence reappear after an older archive and snooze', () => {
    const rows = deriveInboxRows(snapshot({
      activities: [{
        sessionId: 'again', seq: 12, turn: 3, occurredAt: 120,
        outcome: 'failed', reasonCode: 'max-tokens', detail: 'limit',
      }],
      preferences: [{
        sessionId: 'again', followed: true, archivedThroughSeq: 8,
        snooze: { sourceSeq: 8, until: 50_000 },
      }],
    }), sessionState([summary('again')]), 1_000)
    expect(rows[0]).toMatchObject({ archived: false, followed: true })
    expect(rows[0]?.snoozedUntil).toBeUndefined()
    expect(rowsForFilter(rows, 'failed')).toHaveLength(1)
    expect(rowsForFilter(rows, 'following')).toHaveLength(1)
  })

  it('routes a hidden subagent activity to its visible parent task', () => {
    const rows = deriveInboxRows(snapshot({
      activities: [{
        sessionId: 'child', seq: 3, turn: 1, occurredAt: 100,
        outcome: 'blocked', reasonCode: 'blocked', detail: 'blocked',
        parentSessionId: 'parent', origin: 'subagent',
      }],
    }), sessionState([summary('parent')]), 1_000)
    expect(rows[0]).toMatchObject({
      title: 'Subagent child', parentTitle: 'Title parent', openTargetId: 'parent', isSubagent: true,
    })
  })
})
