import { describe, expect, it } from 'vitest'
import type { SessionId, SessionListState, SessionSummary } from '@deepseek-ai/dsh-client-runtime/client'
import type { ActivityInboxSnapshot } from '../src/contracts.js'
import { deriveAgentActivities } from '../src/client/domain/activity.js'

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

function sessionState(rows: SessionSummary[], current?: string): SessionListState {
  return {
    ids: rows.map(row => row.id),
    byId: Object.fromEntries(rows.map(row => [row.id, row])) as Record<SessionId, SessionSummary>,
    current: current === undefined ? undefined : id(current),
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

describe('shared activity domain', () => {
  it('decorates the Host Presence snapshot instead of re-deriving its state', () => {
    const activities = deriveAgentActivities(snapshot({
      presence: {
        version: 1,
        instanceId: 'host-1',
        revision: 2,
        generatedAt: 500,
        ready: true,
        backfillFailures: 0,
        activities: [{
          sessionId: 'task',
          state: 'needs-input',
          detail: 'Waiting for your approval',
          updatedAt: 400,
          sourceSeq: -1,
          followed: false,
          reviewed: false,
          archived: false,
          running: true,
          pendingKind: 'approval',
        }],
      },
    }), sessionState([summary('task', { running: false })], 'task'), 1_000)

    expect(activities[0]).toMatchObject({
      title: 'Title task',
      state: 'needs-input',
      pendingKind: 'approval',
      current: true,
    })
  })

  it('uses live running state ahead of a delayed terminal snapshot', () => {
    const activities = deriveAgentActivities(snapshot({
      activities: [{
        sessionId: 'task', seq: 4, turn: 1, occurredAt: 90,
        outcome: 'completed', reasonCode: 'completed', detail: 'Turn completed',
      }],
    }), sessionState([summary('task', { running: true, updatedAt: 110 })], 'task'), 1_000)

    expect(activities[0]).toMatchObject({
      sessionId: 'task',
      state: 'running',
      terminalOutcome: 'completed',
      current: true,
      sourceSeq: 4,
      detail: 'Running',
    })
  })

  it('keeps exact evidence and parent navigation in the shared model', () => {
    const activities = deriveAgentActivities(snapshot({
      activities: [{
        sessionId: 'child', seq: 8, turn: 2, occurredAt: 120,
        outcome: 'blocked', reasonCode: 'blocked', detail: 'blocked',
        parentSessionId: 'parent', origin: 'subagent',
      }],
    }), sessionState([summary('parent')]), 1_000)

    expect(activities[0]).toMatchObject({
      state: 'blocked',
      sourceSeq: 8,
      openTargetId: 'parent',
      parentTitle: 'Title parent',
      isSubagent: true,
    })
  })
})
