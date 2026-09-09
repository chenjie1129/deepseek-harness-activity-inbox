import { describe, expect, it } from 'vitest'
import type { ActivityPresenceSnapshot } from '../src/contracts.js'
import {
  cursorFor,
  isPresenceClientMessage,
  isPresenceServerMessage,
  shouldAcceptPresence,
  synchronizePresence,
} from '../src/presence/protocol.js'

function snapshot(instanceId: string, revision: number): ActivityPresenceSnapshot {
  return {
    version: 1,
    instanceId,
    revision,
    generatedAt: 1_000,
    ready: true,
    backfillFailures: 0,
    activities: [],
  }
}

describe('Presence transport protocol', () => {
  it('accepts only bounded versioned subscribe messages', () => {
    expect(isPresenceClientMessage({
      type: 'presence/subscribe',
      version: 1,
      cursor: { instanceId: 'host-a', revision: 4 },
    })).toBe(true)
    expect(isPresenceClientMessage({
      type: 'presence/subscribe',
      version: 2,
    })).toBe(false)
    expect(isPresenceClientMessage({
      type: 'presence/subscribe',
      version: 1,
      cursor: { instanceId: '', revision: -1 },
    })).toBe(false)
  })

  it('returns unchanged only for the exact current Host revision', () => {
    const current = snapshot('host-a', 4)
    expect(synchronizePresence(current, cursorFor(current))).toEqual({
      type: 'presence/unchanged',
      version: 1,
      cursor: { instanceId: 'host-a', revision: 4 },
    })
    expect(synchronizePresence(current, { instanceId: 'host-a', revision: 3 })).toMatchObject({
      type: 'presence/snapshot',
      snapshot: current,
    })
  })

  it('accepts a lower revision after Host restart but rejects stale same-instance data', () => {
    const current = { instanceId: 'host-a', revision: 9 }
    expect(shouldAcceptPresence(current, snapshot('host-a', 8))).toBe(false)
    expect(shouldAcceptPresence(current, snapshot('host-a', 10))).toBe(true)
    expect(shouldAcceptPresence(current, snapshot('host-b', 0))).toBe(true)
  })

  it('validates server messages and rejects malformed snapshot evidence', () => {
    expect(isPresenceServerMessage({
      type: 'presence/snapshot',
      version: 1,
      snapshot: snapshot('host-a', 1),
    })).toBe(true)
    expect(isPresenceServerMessage({
      type: 'presence/snapshot',
      version: 1,
      snapshot: {
        ...snapshot('host-a', 1),
        activities: [{ sessionId: 'task', state: 'running' }],
      },
    })).toBe(false)
    expect(isPresenceServerMessage({
      type: 'presence/error',
      version: 1,
      code: 'bad-message',
      message: 'x'.repeat(501),
    })).toBe(false)
  })
})
