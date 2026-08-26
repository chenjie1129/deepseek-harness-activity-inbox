/** Deterministic event fold plus durable operator preferences. */

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import {
  ACTIVITY_INBOX_STATE_VERSION,
  type ActivityInboxSnapshot,
  type ActivityMutation,
  type ActivityOutcome,
  type ActivityPreference,
  type ActivityRecord,
} from './contracts.js'

interface PreferenceFile {
  version: 1
  revision: number
  preferences: ActivityPreference[]
}

const MAX_DETAIL_LENGTH = 500

function boundedDetail(value: string): string {
  return value.length <= MAX_DETAIL_LENGTH ? value : `${value.slice(0, MAX_DETAIL_LENGTH - 1)}…`
}

function reasonView(reason: { kind: string; [key: string]: unknown }): {
  outcome: ActivityOutcome
  reasonCode: string
  detail: string
} | undefined {
  switch (reason.kind) {
    case 'completed':
      return { outcome: 'completed', reasonCode: 'completed', detail: 'Turn completed' }
    case 'blocked':
      return { outcome: 'blocked', reasonCode: 'blocked', detail: 'The task reported that it is blocked' }
    case 'max-tokens':
      return { outcome: 'failed', reasonCode: 'max-tokens', detail: 'The turn reached its output-token limit' }
    case 'interrupted':
      return { outcome: 'failed', reasonCode: 'interrupted', detail: 'The turn was interrupted before it could finish' }
    case 'error': {
      const error = reason.error
      const message = typeof error === 'object' && error !== null && !Array.isArray(error)
        && typeof (error as Record<string, unknown>).message === 'string'
        ? (error as Record<string, unknown>).message as string
        : 'The turn ended with an error'
      return { outcome: 'failed', reasonCode: 'error', detail: boundedDetail(message) }
    }
    // User, parent, hook, and disposal cancellations are intentional control
    // outcomes. They do not become false-positive failures in the inbox.
    case 'aborted':
      return undefined
    default:
      // TurnEndReason is merge-extensible. Unknown plugin outcomes stay out
      // until this plugin can classify them without guessing.
      return undefined
  }
}

function validOptionalSeq(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
}

function parsePreference(value: unknown): ActivityPreference | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>
  if (typeof input.sessionId !== 'string' || input.sessionId.length < 1 || input.sessionId.length > 256) return undefined
  if (typeof input.followed !== 'boolean') return undefined
  if (!validOptionalSeq(input.reviewedThroughSeq) || !validOptionalSeq(input.archivedThroughSeq)) return undefined
  let snooze: ActivityPreference['snooze']
  if (input.snooze !== undefined) {
    if (typeof input.snooze !== 'object' || input.snooze === null || Array.isArray(input.snooze)) return undefined
    const candidate = input.snooze as Record<string, unknown>
    if (typeof candidate.until !== 'number' || !Number.isSafeInteger(candidate.until) || candidate.until < 0
      || typeof candidate.sourceSeq !== 'number' || !Number.isSafeInteger(candidate.sourceSeq) || candidate.sourceSeq < -1) return undefined
    snooze = { until: candidate.until, sourceSeq: candidate.sourceSeq }
  }
  return {
    sessionId: input.sessionId,
    followed: input.followed,
    ...input.reviewedThroughSeq === undefined ? {} : { reviewedThroughSeq: input.reviewedThroughSeq as number },
    ...input.archivedThroughSeq === undefined ? {} : { archivedThroughSeq: input.archivedThroughSeq as number },
    ...snooze === undefined ? {} : { snooze },
  }
}

function parsePreferenceFile(value: unknown): PreferenceFile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('activity inbox state must be a JSON object')
  }
  const input = value as Record<string, unknown>
  if (input.version !== ACTIVITY_INBOX_STATE_VERSION) {
    throw new Error(`activity inbox state version must be ${ACTIVITY_INBOX_STATE_VERSION}`)
  }
  if (typeof input.revision !== 'number' || !Number.isSafeInteger(input.revision) || input.revision < 0) {
    throw new Error('activity inbox state revision must be a non-negative safe integer')
  }
  if (!Array.isArray(input.preferences)) throw new Error('activity inbox preferences must be an array')
  const preferences = input.preferences.map(parsePreference)
  if (preferences.some(preference => preference === undefined)) {
    throw new Error('activity inbox state contains a malformed preference')
  }
  const rows = preferences as ActivityPreference[]
  if (new Set(rows.map(row => row.sessionId)).size !== rows.length) {
    throw new Error('activity inbox state contains a duplicate session preference')
  }
  return { version: 1, revision: input.revision, preferences: rows }
}

async function writeFileAtomic(filename: string, value: PreferenceFile): Promise<void> {
  await mkdir(dirname(filename), { recursive: true })
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    await rename(temporary, filename)
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
}

function clonePreference(preference: ActivityPreference | undefined, sessionId: string): ActivityPreference {
  if (preference === undefined) return { sessionId, followed: false }
  return {
    ...preference,
    ...preference.snooze === undefined ? {} : { snooze: { ...preference.snooze } },
  }
}

function hasMeaningfulPreference(preference: ActivityPreference): boolean {
  return preference.followed
    || preference.reviewedThroughSeq !== undefined
    || preference.archivedThroughSeq !== undefined
    || preference.snooze !== undefined
}

/** In-memory read model; event facts are replayed, operator choices are stored. */
export class ActivityInboxStore {
  readonly statePath: string
  private revision = 0
  private backfillReady = false
  private backfillFailures = 0
  private readonly activities = new Map<string, ActivityRecord>()
  private readonly preferences = new Map<string, ActivityPreference>()
  private readonly metadata = new Map<string, Pick<ActivityRecord, 'createdAt' | 'parentSessionId' | 'origin'>>()
  private readonly relevantWatermarks = new Map<string, number>()
  private mutationQueue: Promise<unknown> = Promise.resolve()

  constructor(statePath: string) {
    this.statePath = resolve(statePath)
  }

  async initialize(): Promise<void> {
    let text: string
    try {
      text = await readFile(this.statePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      throw new Error('activity inbox state is not valid JSON')
    }
    const parsed = parsePreferenceFile(raw)
    this.revision = parsed.revision
    for (const preference of parsed.preferences) this.preferences.set(preference.sessionId, preference)
  }

  noteSession(header: SessionHeader): void {
    this.metadata.set(String(header.id), {
      createdAt: header.createdAt,
      ...header.parentSession === undefined ? {} : { parentSessionId: String(header.parentSession) },
      ...header.origin === undefined ? {} : { origin: header.origin },
    })
  }

  ingest(header: SessionHeader, events: readonly SessionEvent[]): void {
    this.noteSession(header)
    for (const event of events) this.ingestEvent(header, event)
  }

  ingestEvent(header: SessionHeader, event: SessionEvent): void {
    this.noteSession(header)
    if (event.type !== 'turn/start' && event.type !== 'turn/end') return
    const sessionId = String(header.id)
    const watermark = this.relevantWatermarks.get(sessionId) ?? -1
    if (event.seq <= watermark) return
    this.relevantWatermarks.set(sessionId, event.seq)
    if (event.type === 'turn/start') {
      this.activities.delete(sessionId)
      return
    }
    const data = event.data as { turn: number; reason: { kind: string; [key: string]: unknown } }
    const view = reasonView(data.reason)
    if (view === undefined) {
      this.activities.delete(sessionId)
      return
    }
    const meta = this.metadata.get(sessionId)
    this.activities.set(sessionId, {
      sessionId,
      seq: event.seq,
      turn: data.turn,
      occurredAt: event.time,
      ...view,
      ...meta,
    })
  }

  markBackfillComplete(failures: number): void {
    this.backfillFailures = failures
    this.backfillReady = true
  }

  snapshot(): ActivityInboxSnapshot {
    return {
      version: 1,
      revision: this.revision,
      backfillReady: this.backfillReady,
      backfillFailures: this.backfillFailures,
      activities: [...this.activities.values()]
        .map(activity => ({ ...activity }))
        .sort((left, right) => right.occurredAt - left.occurredAt || right.seq - left.seq),
      preferences: [...this.preferences.values()]
        .map(preference => ({
          ...preference,
          ...preference.snooze === undefined ? {} : { snooze: { ...preference.snooze } },
        }))
        .sort((left, right) => left.sessionId.localeCompare(right.sessionId)),
    }
  }

  mutate(mutation: ActivityMutation): Promise<ActivityInboxSnapshot> {
    const operation = this.mutationQueue.then(async () => {
      const next = new Map(this.preferences)
      const current = clonePreference(next.get(mutation.sessionId), mutation.sessionId)
      const activity = this.activities.get(mutation.sessionId)
      switch (mutation.action) {
        case 'set-followed':
          current.followed = mutation.followed
          break
        case 'mark-reviewed':
          if (activity?.seq !== mutation.sourceSeq) throw new Error('The activity changed; refresh and try again.')
          current.reviewedThroughSeq = Math.max(current.reviewedThroughSeq ?? -1, mutation.sourceSeq)
          break
        case 'mark-unreviewed':
          if (activity?.seq !== mutation.sourceSeq) throw new Error('The activity changed; refresh and try again.')
          if (mutation.sourceSeq === 0) delete current.reviewedThroughSeq
          else current.reviewedThroughSeq = mutation.sourceSeq - 1
          break
        case 'archive':
          if (activity?.seq !== mutation.sourceSeq) throw new Error('The activity changed; refresh and try again.')
          current.archivedThroughSeq = Math.max(current.archivedThroughSeq ?? -1, mutation.sourceSeq)
          break
        case 'restore':
          if (activity?.seq !== mutation.sourceSeq) throw new Error('The activity changed; refresh and try again.')
          if (mutation.sourceSeq === 0) delete current.archivedThroughSeq
          else current.archivedThroughSeq = mutation.sourceSeq - 1
          break
        case 'snooze': {
          const now = Date.now()
          if (mutation.until <= now || mutation.until > now + 30 * 24 * 60 * 60 * 1_000) {
            throw new Error('Snooze must end within the next 30 days.')
          }
          current.snooze = { until: mutation.until, sourceSeq: mutation.sourceSeq }
          break
        }
        case 'unsnooze':
          delete current.snooze
          break
      }
      if (hasMeaningfulPreference(current)) next.set(mutation.sessionId, current)
      else next.delete(mutation.sessionId)
      const nextRevision = this.revision + 1
      await writeFileAtomic(this.statePath, {
        version: 1,
        revision: nextRevision,
        preferences: [...next.values()],
      })
      this.preferences.clear()
      for (const [key, value] of next) this.preferences.set(key, value)
      this.revision = nextRevision
      return this.snapshot()
    })
    this.mutationQueue = operation.catch(() => {})
    return operation
  }

  async close(): Promise<void> {
    await this.mutationQueue
  }
}
