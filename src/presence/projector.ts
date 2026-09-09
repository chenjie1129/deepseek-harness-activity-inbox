/** Pure global focus projection shared by web and future desktop renderers. */

import type {
  ActivityPresenceSnapshot,
  AgentPresenceState,
  PresenceActivity,
} from '../contracts.js'

export type PetPresenceState = AgentPresenceState | 'offline'
export type PetVisualTrack = 'idle' | 'running' | 'waiting' | 'review' | 'blocked' | 'failed' | 'offline'

export interface PetProjection {
  state: PetPresenceState
  track: PetVisualTrack
  label: string
  detail: string
  attentionCount: number
  transitionKey: string
  targetSessionId?: string
  sourceSeq?: number
}

const STATE_PRIORITY: Record<AgentPresenceState, number> = {
  'needs-input': 0,
  blocked: 1,
  failed: 2,
  ready: 3,
  running: 4,
  idle: 5,
}

const STATE_LABEL: Record<PetPresenceState, string> = {
  offline: 'Activity unavailable',
  idle: 'All quiet',
  running: 'Working',
  'needs-input': 'Needs input',
  blocked: 'Blocked',
  failed: 'Task failed',
  ready: 'Ready to review',
}

const STATE_TRACK: Record<PetPresenceState, PetVisualTrack> = {
  offline: 'offline',
  idle: 'idle',
  running: 'running',
  'needs-input': 'waiting',
  blocked: 'blocked',
  failed: 'failed',
  ready: 'review',
}

export function isAttentionState(state: PetPresenceState): boolean {
  return state === 'needs-input' || state === 'blocked' || state === 'failed'
}

function controlsPet(activity: PresenceActivity, now: number): boolean {
  if (activity.archived || (activity.snoozedUntil !== undefined && activity.snoozedUntil > now)) return false
  if (activity.state === 'idle') return false
  if ((activity.state === 'blocked' || activity.state === 'failed' || activity.state === 'ready')
    && activity.reviewed) return false
  return true
}

function compareActivities(
  left: PresenceActivity,
  right: PresenceActivity,
  currentSessionId: string | undefined,
): number {
  return STATE_PRIORITY[left.state] - STATE_PRIORITY[right.state]
    || Number(right.sessionId === currentSessionId) - Number(left.sessionId === currentSessionId)
    || Number(right.followed) - Number(left.followed)
    || right.updatedAt - left.updatedAt
    || left.sessionId.localeCompare(right.sessionId)
}

export function derivePetProjection(
  snapshot: ActivityPresenceSnapshot | undefined,
  currentSessionId?: string,
  now = Date.now(),
): PetProjection {
  if (snapshot === undefined) {
    return {
      state: 'offline',
      track: 'offline',
      label: STATE_LABEL.offline,
      detail: 'Waiting for the Activity service',
      attentionCount: 0,
      transitionKey: 'offline',
    }
  }

  const candidates = snapshot.activities
    .filter(activity => controlsPet(activity, now))
    .sort((left, right) => compareActivities(left, right, currentSessionId))
  const attentionCount = candidates.filter(activity => isAttentionState(activity.state)).length
  const focus = candidates[0]
  if (focus === undefined) {
    return {
      state: 'idle',
      track: 'idle',
      label: STATE_LABEL.idle,
      detail: 'No active task needs attention',
      attentionCount,
      transitionKey: `idle:${snapshot.instanceId}:${snapshot.revision}`,
    }
  }

  return {
    state: focus.state,
    track: STATE_TRACK[focus.state],
    label: STATE_LABEL[focus.state],
    detail: focus.detail,
    attentionCount,
    transitionKey: `${snapshot.instanceId}:${focus.state}:${focus.sessionId}:${focus.sourceSeq}:${snapshot.revision}`,
    targetSessionId: focus.sessionId,
    ...focus.sourceSeq < 0 ? {} : { sourceSeq: focus.sourceSeq },
  }
}

export function shouldTransitionImmediately(state: PetPresenceState): boolean {
  return isAttentionState(state) || state === 'offline'
}

export function shouldPausePetAnimation(documentHidden: boolean, reducedMotion: boolean): boolean {
  return documentHidden || reducedMotion
}
