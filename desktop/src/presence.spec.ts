import { describe, expect, it, vi } from 'vitest'
import type { ActivityPresenceSnapshot } from '@chenjie1129/dsh-activity-inbox-plugin/presence'
import {
  DEFAULT_DESKTOP_PREFERENCES,
  loadDesktopPreferences,
  mergeRuntimeState,
  projectionForRuntime,
  saveDesktopPreferences,
  type DesktopRuntimeState,
} from './presence'

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

describe('desktop Presence state', () => {
  it('renders disconnected transports as offline even with a cached snapshot', () => {
    const runtime: DesktopRuntimeState = {
      phase: 'reconnecting',
      attempt: 2,
      snapshot: snapshot('host-a', 4),
    }
    expect(projectionForRuntime(runtime)).toMatchObject({
      state: 'offline',
      track: 'offline',
    })
  })

  it('rejects stale revisions but accepts a restarted Host instance', () => {
    const current: DesktopRuntimeState = {
      phase: 'connected',
      attempt: 0,
      snapshot: snapshot('host-a', 8),
    }
    expect(mergeRuntimeState(current, {
      phase: 'connected',
      attempt: 0,
      snapshot: snapshot('host-a', 7),
    }).snapshot?.revision).toBe(8)
    expect(mergeRuntimeState(current, {
      phase: 'connected',
      attempt: 0,
      snapshot: snapshot('host-b', 1),
    }).snapshot).toMatchObject({ instanceId: 'host-b', revision: 1 })
  })

  it('falls back safely when desktop preferences are unavailable or malformed', () => {
    expect(loadDesktopPreferences(undefined)).toEqual(DEFAULT_DESKTOP_PREFERENCES)
    expect(loadDesktopPreferences({
      getItem: () => '{"version":1,"clickThrough":"yes"}',
    })).toEqual(DEFAULT_DESKTOP_PREFERENCES)
    expect(loadDesktopPreferences({
      getItem: () => { throw new Error('denied') },
    })).toEqual(DEFAULT_DESKTOP_PREFERENCES)
  })

  it('persists only the versioned desktop presentation settings', () => {
    const setItem = vi.fn()
    const preferences = {
      ...DEFAULT_DESKTOP_PREFERENCES,
      animationsEnabled: false,
      detailsOpen: true,
    }
    saveDesktopPreferences({ setItem }, preferences)
    expect(setItem).toHaveBeenCalledWith(
      'dsh.activity-pet.desktop.v1',
      JSON.stringify(preferences),
    )
  })
})
