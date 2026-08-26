/** Browser-safe contracts shared by the Host index and the sidebar client. */

export const ACTIVITY_INBOX_RPC_CHANNEL = '/activity-inbox'
export const ACTIVITY_INBOX_STATE_VERSION = 1

export type ActivityOutcome = 'completed' | 'failed' | 'blocked'

/** Latest terminal activity for one Harness session. */
export interface ActivityRecord {
  sessionId: string
  seq: number
  turn: number
  occurredAt: number
  outcome: ActivityOutcome
  reasonCode: string
  detail: string
  createdAt?: number
  parentSessionId?: string
  origin?: 'subagent'
}

/** Operator-owned state. Sequence anchors make a new turn re-arm an item. */
export interface ActivityPreference {
  sessionId: string
  followed: boolean
  reviewedThroughSeq?: number
  archivedThroughSeq?: number
  snooze?: {
    until: number
    sourceSeq: number
  }
}

export interface ActivityInboxSnapshot {
  version: 1
  revision: number
  backfillReady: boolean
  backfillFailures: number
  activities: ActivityRecord[]
  preferences: ActivityPreference[]
}

export type ActivityMutation =
  | { action: 'set-followed'; sessionId: string; followed: boolean }
  | { action: 'mark-reviewed'; sessionId: string; sourceSeq: number }
  | { action: 'mark-unreviewed'; sessionId: string; sourceSeq: number }
  | { action: 'archive'; sessionId: string; sourceSeq: number }
  | { action: 'restore'; sessionId: string; sourceSeq: number }
  | { action: 'snooze'; sessionId: string; sourceSeq: number; until: number }
  | { action: 'unsnooze'; sessionId: string }

function safeInteger(value: unknown, min = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min
}

/** Narrow untrusted RPC payloads before they reach persisted operator state. */
export function isActivityMutation(value: unknown): value is ActivityMutation {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const input = value as Record<string, unknown>
  if (typeof input.sessionId !== 'string' || input.sessionId.length < 1 || input.sessionId.length > 256) return false
  switch (input.action) {
    case 'set-followed':
      return typeof input.followed === 'boolean'
    case 'mark-reviewed':
    case 'mark-unreviewed':
    case 'archive':
    case 'restore':
      return safeInteger(input.sourceSeq)
    case 'snooze':
      return safeInteger(input.sourceSeq, -1) && safeInteger(input.until)
    case 'unsnooze':
      return true
    default:
      return false
  }
}
