/** Inbox-specific projection over the shared deterministic activity domain. */

import type { SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { ActivityInboxSnapshot } from '../contracts.js'
import {
  deriveAgentActivities,
  type AgentActivity,
  type PendingInteractionKind,
} from './domain/activity.js'

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
  pendingKind?: PendingInteractionKind
  reasonCode?: string
  isSubagent: boolean
}

function inboxCategory(activity: AgentActivity): InboxCategory {
  if (activity.pendingKind !== undefined || activity.terminalOutcome === 'blocked') return 'needs-action'
  if (activity.terminalOutcome === 'failed') return 'failed'
  if (activity.terminalOutcome === 'completed') return 'completed'
  return activity.running ? 'running' : 'idle'
}

/** Preserve the v0.1 Inbox behavior while sharing normalized activity facts. */
export function deriveInboxRows(
  snapshot: ActivityInboxSnapshot | undefined,
  sessions: SessionListState,
  now = Date.now(),
): InboxRow[] {
  return projectInboxRows(deriveAgentActivities(snapshot, sessions, now))
}

export function projectInboxRows(activities: readonly AgentActivity[]): InboxRow[] {
  const rows = activities.map(activity => ({
    sessionId: activity.sessionId,
    title: activity.title,
    ...activity.parentTitle === undefined ? {} : { parentTitle: activity.parentTitle },
    ...activity.openTargetId === undefined ? {} : { openTargetId: activity.openTargetId },
    category: inboxCategory(activity),
    detail: activity.detail,
    occurredAt: activity.updatedAt,
    sourceSeq: activity.sourceSeq,
    followed: activity.followed,
    reviewed: activity.reviewed,
    archived: activity.archived,
    ...activity.snoozedUntil === undefined ? {} : { snoozedUntil: activity.snoozedUntil },
    ...activity.pendingKind === undefined ? {} : { pendingKind: activity.pendingKind },
    ...activity.reasonCode === undefined ? {} : { reasonCode: activity.reasonCode },
    isSubagent: activity.isSubagent,
  }))

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
