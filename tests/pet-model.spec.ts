import { describe, expect, it } from 'vitest'
import type {
  ActivityPresenceSnapshot,
  AgentPresenceState,
  PresenceActivity,
} from '../src/contracts.js'
import {
  derivePetProjection,
  shouldPausePetAnimation,
  shouldTransitionImmediately,
} from '../src/client/pet/model.js'

function snapshot(activities: PresenceActivity[] = []): ActivityPresenceSnapshot {
  return {
    version: 1,
    instanceId: 'host-1',
    revision: 3,
    generatedAt: 500,
    ready: true,
    backfillFailures: 0,
    activities,
  }
}

function activity(
  sessionId: string,
  state: AgentPresenceState,
  overrides: Partial<PresenceActivity> = {},
): PresenceActivity {
  return {
    sessionId,
    state,
    detail: `Detail ${sessionId}`,
    updatedAt: 100,
    sourceSeq: 4,
    followed: false,
    reviewed: false,
    archived: false,
    running: state === 'running',
    ...overrides,
  }
}

describe('Pet projection', () => {
  it('shows offline until the Host snapshot is available', () => {
    expect(derivePetProjection(undefined)).toMatchObject({
      state: 'offline',
      track: 'offline',
      attentionCount: 0,
    })
  })

  it('selects attention by semantic priority before task affinity', () => {
    const projection = derivePetProjection(snapshot([
      activity('current-failure', 'failed', { updatedAt: 200 }),
      activity('background-wait', 'needs-input', { updatedAt: 100 }),
      activity('running', 'running', { followed: true, updatedAt: 300 }),
    ]), 'current-failure')

    expect(projection).toMatchObject({
      state: 'needs-input',
      track: 'waiting',
      targetSessionId: 'background-wait',
      attentionCount: 2,
    })
  })

  it('uses current, followed, recency, and id as stable tie breakers', () => {
    const projection = derivePetProjection(snapshot([
      activity('z-task', 'running', { followed: true, updatedAt: 500 }),
      activity('b-task', 'running', { updatedAt: 100 }),
      activity('a-task', 'running', { updatedAt: 900 }),
    ]), 'b-task')
    expect(projection.targetSessionId).toBe('b-task')
  })

  it('suppresses reviewed, snoozed, and archived terminal outcomes', () => {
    const projection = derivePetProjection(snapshot([
      activity('reviewed', 'ready', { reviewed: true }),
      activity('snoozed', 'failed', { snoozedUntil: 2_000 }),
      activity('archived', 'blocked', { archived: true }),
    ]), undefined, 1_000)
    expect(projection).toMatchObject({ state: 'idle', attentionCount: 0 })
  })

  it('defines immediate attention transitions and animation pause policy', () => {
    expect(shouldTransitionImmediately('needs-input')).toBe(true)
    expect(shouldTransitionImmediately('running')).toBe(false)
    expect(shouldPausePetAnimation(true, false)).toBe(true)
    expect(shouldPausePetAnimation(false, true)).toBe(true)
    expect(shouldPausePetAnimation(false, false)).toBe(false)
  })
})
