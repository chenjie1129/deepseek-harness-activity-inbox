/** Pure view derivation: one current row per session, no model-generated summary. */

import type { SessionId, SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  ActivityInboxSnapshot,
  ActivityPreference,
  ActivityRecord,
} from '../contracts.js'

export type InboxCategory = 'needs-action' | 'failed' | 'completed' | 'running' | 'idle'
export type InboxFilter = 'needs-action' | 'failed' | 'completed' | 'following' | 'archived'

export interface InboxRow {
  sessionId: string
  title: string
  parentTitle?: string
  openTargetId?: string
  category: InboxCategory
  detail: string
  occurredAt: number
  sourceSeq: number
  followed: boolean
  reviewed: boolean
  archived: boolean
  snoozedUntil?: number
  pendingKind?: 'approval' | 'plan-review' | 'question'
  reasonCode?: string
  isSubagent: boolean
}

function titleFor(sessionId: string, activity: ActivityRecord | undefined, sessions: SessionListState): string {
  const summary = sessions.byId[sessionId as SessionId]
  if (summary !== undefined) return summary.displayTitle
  const prefix = activity?.origin === 'subagent' ? 'Subagent' : 'Task'
  return `${prefix} ${sessionId.slice(0, 8)}`
}

function detailForPending(kind: NonNullable<InboxRow['pendingKind']>): string {
  switch (kind) {
    case 'approval': return 'Waiting for your approval'
    case 'plan-review': return 'Waiting for your plan review'
    case 'question': return 'Waiting for your answer'
  }
}

function rowCategory(activity: ActivityRecord | undefined, pending: InboxRow['pendingKind'], running: boolean): InboxCategory {
  if (pending !== undefined || activity?.outcome === 'blocked') return 'needs-action'
  if (activity?.outcome === 'failed') return 'failed'
  if (activity?.outcome === 'completed') return 'completed'
  return running ? 'running' : 'idle'
}

/** Merge durable Host outcomes, live waits, and operator preferences. */
export function deriveInboxRows(
  snapshot: ActivityInboxSnapshot | undefined,
  sessions: SessionListState,
  now = Date.now(),
): InboxRow[] {
  const activities = new Map((snapshot?.activities ?? []).map(activity => [activity.sessionId, activity]))
  const preferences = new Map((snapshot?.preferences ?? []).map(preference => [preference.sessionId, preference]))
  const ids = new Set<string>([...activities.keys(), ...preferences.keys()])
  for (const id of sessions.ids) {
    const summary = sessions.byId[id]
    if (summary?.pendingInteraction !== undefined) ids.add(String(id))
  }

  const rows: InboxRow[] = []
  for (const sessionId of ids) {
    const activity = activities.get(sessionId)
    const preference: ActivityPreference = preferences.get(sessionId) ?? { sessionId, followed: false }
    const summary = sessions.byId[sessionId as SessionId]
    const pending = summary?.pendingInteraction
    if (activity === undefined && pending === undefined && !preference.followed) continue
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
    rows.push({
      sessionId,
      title: titleFor(sessionId, activity, sessions),
      ...parent === undefined ? {} : { parentTitle: parent.displayTitle },
      ...openTargetId === undefined ? {} : { openTargetId },
      category: rowCategory(activity, pending, summary?.running === true),
      detail: pending === undefined ? activity?.detail ?? (summary?.running === true ? 'Running' : 'Followed task') : detailForPending(pending),
      occurredAt: activity?.occurredAt ?? summary?.updatedAt ?? 0,
      sourceSeq,
      followed: preference.followed,
      reviewed: pending === undefined && activity !== undefined
        && (preference.reviewedThroughSeq ?? -1) >= activity.seq,
      archived,
      ...snoozed ? { snoozedUntil: preference.snooze!.until } : {},
      ...pending === undefined ? {} : { pendingKind: pending },
      ...activity === undefined ? {} : { reasonCode: activity.reasonCode },
      isSubagent: activity?.origin === 'subagent' || summary?.origin === 'subagent',
    })
  }

  const rank: Record<InboxCategory, number> = {
    'needs-action': 0,
    failed: 1,
    completed: 2,
    running: 3,
    idle: 4,
  }
  return rows.sort((left, right) => rank[left.category] - rank[right.category]
    || right.occurredAt - left.occurredAt
    || left.title.localeCompare(right.title))
}

export function rowsForFilter(rows: readonly InboxRow[], filter: InboxFilter): InboxRow[] {
  if (filter === 'archived') return rows.filter(row => row.archived)
  const visible = rows.filter(row => !row.archived)
  if (filter === 'following') return visible.filter(row => row.followed)
  return visible.filter(row => row.snoozedUntil === undefined && row.category === filter)
}

/** Badge policy: unresolved waits plus unreviewed blocked/failed outcomes. */
export function activityBadgeCount(rows: readonly InboxRow[]): number {
  return rows.filter(row => !row.archived && row.snoozedUntil === undefined && (
    row.pendingKind !== undefined
    || (row.category === 'needs-action' && !row.reviewed)
    || (row.category === 'failed' && !row.reviewed)
  )).length
}
