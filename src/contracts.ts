/** Browser-safe contracts shared by the Host index and the sidebar client. */

export const ACTIVITY_INBOX_RPC_CHANNEL = '/activity-inbox'
export const ACTIVITY_INBOX_STATE_VERSION = 1
export const ACTIVITY_PRESENCE_PROTOCOL_VERSION = 1

export type ActivityOutcome = 'completed' | 'failed' | 'blocked'
export type PendingInteractionKind = 'approval' | 'plan-review' | 'question'
export type AgentPresenceState = 'idle' | 'running' | 'needs-input' | 'blocked' | 'failed' | 'ready'

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
  /** Host-authoritative runtime projection for Inbox, Pet, and future desktop clients. */
  presence?: ActivityPresenceSnapshot
}

export interface PresenceActivity {
  sessionId: string
  state: AgentPresenceState
  detail: string
  updatedAt: number
  /** Durable evidence sequence, or -1 for an ephemeral approval request. */
  sourceSeq: number
  followed: boolean
  reviewed: boolean
  archived: boolean
  running: boolean
  terminalOutcome?: ActivityOutcome
  snoozedUntil?: number
  pendingKind?: PendingInteractionKind
  reasonCode?: string
  createdAt?: number
  parentSessionId?: string
  origin?: 'subagent'
}

/** One versioned Host projection shared by every activity presentation. */
export interface ActivityPresenceSnapshot {
  version: 1
  instanceId: string
  revision: number
  generatedAt: number
  ready: boolean
  backfillFailures: number
  activities: PresenceActivity[]
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

function optionalSafeInteger(value: unknown): boolean {
  return value === undefined || safeInteger(value)
}

function isActivityRecord(value: unknown): value is ActivityRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const input = value as Record<string, unknown>
  return typeof input.sessionId === 'string'
    && input.sessionId.length > 0
    && safeInteger(input.seq)
    && safeInteger(input.turn)
    && safeInteger(input.occurredAt)
    && (input.outcome === 'completed' || input.outcome === 'failed' || input.outcome === 'blocked')
    && typeof input.reasonCode === 'string'
    && typeof input.detail === 'string'
    && optionalSafeInteger(input.createdAt)
    && (input.parentSessionId === undefined || typeof input.parentSessionId === 'string')
    && (input.origin === undefined || input.origin === 'subagent')
}

function isActivityPreference(value: unknown): value is ActivityPreference {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const input = value as Record<string, unknown>
  if (typeof input.sessionId !== 'string' || input.sessionId.length === 0 || typeof input.followed !== 'boolean') return false
  if (!optionalSafeInteger(input.reviewedThroughSeq) || !optionalSafeInteger(input.archivedThroughSeq)) return false
  if (input.snooze === undefined) return true
  if (typeof input.snooze !== 'object' || input.snooze === null || Array.isArray(input.snooze)) return false
  const snooze = input.snooze as Record<string, unknown>
  return safeInteger(snooze.until) && safeInteger(snooze.sourceSeq, -1)
}

function isPresenceActivity(value: unknown): value is PresenceActivity {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const input = value as Record<string, unknown>
  return typeof input.sessionId === 'string'
    && input.sessionId.length > 0
    && input.sessionId.length <= 256
    && (
      input.state === 'idle'
      || input.state === 'running'
      || input.state === 'needs-input'
      || input.state === 'blocked'
      || input.state === 'failed'
      || input.state === 'ready'
    )
    && typeof input.detail === 'string'
    && input.detail.length <= 500
    && safeInteger(input.updatedAt)
    && safeInteger(input.sourceSeq, -1)
    && typeof input.followed === 'boolean'
    && typeof input.reviewed === 'boolean'
    && typeof input.archived === 'boolean'
    && typeof input.running === 'boolean'
    && (
      input.terminalOutcome === undefined
      || input.terminalOutcome === 'completed'
      || input.terminalOutcome === 'failed'
      || input.terminalOutcome === 'blocked'
    )
    && (input.snoozedUntil === undefined || safeInteger(input.snoozedUntil))
    && (
      input.pendingKind === undefined
      || input.pendingKind === 'approval'
      || input.pendingKind === 'plan-review'
      || input.pendingKind === 'question'
    )
    && (input.reasonCode === undefined || (
      typeof input.reasonCode === 'string' && input.reasonCode.length <= 128
    ))
    && optionalSafeInteger(input.createdAt)
    && (input.parentSessionId === undefined || typeof input.parentSessionId === 'string')
    && (input.origin === undefined || input.origin === 'subagent')
}

export function isActivityPresenceSnapshot(value: unknown): value is ActivityPresenceSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const input = value as Record<string, unknown>
  return input.version === ACTIVITY_PRESENCE_PROTOCOL_VERSION
    && typeof input.instanceId === 'string'
    && input.instanceId.length > 0
    && input.instanceId.length <= 128
    && safeInteger(input.revision)
    && safeInteger(input.generatedAt)
    && typeof input.ready === 'boolean'
    && safeInteger(input.backfillFailures)
    && Array.isArray(input.activities)
    && input.activities.length <= 10_000
    && input.activities.every(isPresenceActivity)
    && new Set(input.activities.map(activity => (activity as PresenceActivity).sessionId)).size === input.activities.length
}

/** Validate a snapshot received across either supported Harness transport. */
export function isActivityInboxSnapshot(value: unknown): value is ActivityInboxSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const input = value as Record<string, unknown>
  return input.version === ACTIVITY_INBOX_STATE_VERSION
    && safeInteger(input.revision)
    && typeof input.backfillReady === 'boolean'
    && safeInteger(input.backfillFailures)
    && Array.isArray(input.activities)
    && input.activities.every(isActivityRecord)
    && Array.isArray(input.preferences)
    && input.preferences.every(isActivityPreference)
    && (input.presence === undefined || isActivityPresenceSnapshot(input.presence))
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
