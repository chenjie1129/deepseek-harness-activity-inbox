/** Shared deterministic activity model consumed by Inbox and Pet projections. */

import type { SessionId, SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  ActivityInboxSnapshot,
  ActivityPreference,
  ActivityRecord,
  AgentPresenceState,
  PendingInteractionKind,
  PresenceActivity,
} from '../../contracts.js'

export type { AgentPresenceState, PendingInteractionKind } from '../../contracts.js'

export interface AgentActivity extends PresenceActivity {
  title: string
  parentTitle?: string
  openTargetId?: string
  current: boolean
  isSubagent: boolean
}

function titleFor(sessionId: string, activity: ActivityRecord | undefined, sessions: SessionListState): string {
  const summary = sessions.byId[sessionId as SessionId]
  if (summary !== undefined) return summary.displayTitle
  const prefix = activity?.origin === 'subagent' ? 'Subagent' : 'Task'
  return `${prefix} ${sessionId.slice(0, 8)}`
}

function detailForPending(kind: PendingInteractionKind): string {
  switch (kind) {
    case 'approval': return 'Waiting for your approval'
    case 'plan-review': return 'Waiting for your plan review'
    case 'question': return 'Waiting for your answer'
  }
}

function presenceState(
  activity: ActivityRecord | undefined,
  pending: PendingInteractionKind | undefined,
  running: boolean,
): AgentPresenceState {
  if (pending !== undefined) return 'needs-input'
  // The browser knows about a new running turn before the Host snapshot has
  // necessarily cleared its previous terminal row.
  if (running) return 'running'
  switch (activity?.outcome) {
    case 'blocked': return 'blocked'
    case 'failed': return 'failed'
    case 'completed': return 'ready'
    default: return 'idle'
  }
}

/** Merge Host facts, live session state, and operator preferences once. */
export function deriveAgentActivities(
  snapshot: ActivityInboxSnapshot | undefined,
  sessions: SessionListState,
  now = Date.now(),
): AgentActivity[] {
  if (snapshot?.presence !== undefined) {
    return snapshot.presence.activities.map(activity => {
      const summary = sessions.byId[activity.sessionId as SessionId]
      const parentSessionId = activity.parentSessionId
        ?? (summary?.parentId === undefined ? undefined : String(summary.parentId))
      const parent = parentSessionId === undefined ? undefined : sessions.byId[parentSessionId as SessionId]
      const openTargetId = summary !== undefined
        ? activity.sessionId
        : parent === undefined ? undefined : parentSessionId
      return {
        ...activity,
        title: titleFor(activity.sessionId, undefined, sessions),
        ...parent === undefined ? {} : { parentTitle: parent.displayTitle },
        ...openTargetId === undefined ? {} : { openTargetId },
        current: sessions.current !== undefined && String(sessions.current) === activity.sessionId,
        isSubagent: activity.origin === 'subagent' || summary?.origin === 'subagent',
      }
    })
  }

  const activities = new Map((snapshot?.activities ?? []).map(activity => [activity.sessionId, activity]))
  const preferences = new Map((snapshot?.preferences ?? []).map(preference => [preference.sessionId, preference]))
  const ids = new Set<string>([...activities.keys(), ...preferences.keys()])
  for (const id of sessions.ids) {
    const summary = sessions.byId[id]
    if (summary?.pendingInteraction !== undefined || summary?.running === true) ids.add(String(id))
  }

  const rows: AgentActivity[] = []
  for (const sessionId of ids) {
    const activity = activities.get(sessionId)
    const preference: ActivityPreference = preferences.get(sessionId) ?? { sessionId, followed: false }
    const summary = sessions.byId[sessionId as SessionId]
    const pending = summary?.pendingInteraction
    if (activity === undefined && pending === undefined && summary?.running !== true && !preference.followed) continue
    const sourceSeq = activity?.seq ?? -1
    const parentSessionId = activity?.parentSessionId ?? (summary?.parentId === undefined ? undefined : String(summary.parentId))
    const parent = parentSessionId === undefined ? undefined : sessions.byId[parentSessionId as SessionId]
    const archived = pending === undefined && activity !== undefined
      && (preference.archivedThroughSeq ?? -1) >= activity.seq
    const snoozed = preference.snooze !== undefined
      && preference.snooze.until > now
      && preference.snooze.sourceSeq >= sourceSeq
    const openTargetId = summary !== undefined
      ? sessionId
      : parent === undefined ? undefined : parentSessionId
    const running = summary?.running === true
    rows.push({
      sessionId,
      title: titleFor(sessionId, activity, sessions),
      ...parent === undefined ? {} : { parentTitle: parent.displayTitle },
      ...openTargetId === undefined ? {} : { openTargetId },
      state: presenceState(activity, pending, running),
      ...activity === undefined ? {} : { terminalOutcome: activity.outcome },
      detail: pending !== undefined
        ? detailForPending(pending)
        : running ? 'Running' : activity?.detail ?? 'Followed task',
      updatedAt: activity?.occurredAt ?? summary?.updatedAt ?? 0,
      sourceSeq,
      followed: preference.followed,
      reviewed: pending === undefined && activity !== undefined
        && (preference.reviewedThroughSeq ?? -1) >= activity.seq,
      archived,
      ...snoozed ? { snoozedUntil: preference.snooze!.until } : {},
      ...pending === undefined ? {} : { pendingKind: pending },
      ...activity === undefined ? {} : { reasonCode: activity.reasonCode },
      running,
      current: sessions.current !== undefined && String(sessions.current) === sessionId,
      isSubagent: activity?.origin === 'subagent' || summary?.origin === 'subagent',
    })
  }

  return rows
}
