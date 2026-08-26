/** DeepSeek Harness Host half: durable event backfill, preference store, and RPC. */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-client-connection'
import z from '@deepseek-ai/schemastery'
import {
  ACTIVITY_INBOX_RPC_CHANNEL,
  isActivityMutation,
} from './contracts.js'
import { ActivityInboxStore } from './store.js'

export * from './contracts.js'
export { ActivityInboxStore } from './store.js'

export const name = 'activity-inbox'
export const inject = ['sessions', 'sessionPersistence', 'connection']

export interface Config {
  statePath?: string
  authority?: 'loopback' | 'trusted-host'
  maxPayloadBytes?: number
  backfillConcurrency?: number
}

export const Config: z<Config> = z.object({
  statePath: z.string(),
  authority: z.union(['loopback', 'trusted-host'] as const).default('loopback'),
  maxPayloadBytes: z.natural().min(1_024).default(16 * 1_024),
  backfillConcurrency: z.natural().min(1).max(16).default(4),
})

function defaultStatePath(): string {
  const configured = process.env.DSH_HOME
  const root = configured !== undefined && configured.trim().length > 0
    ? resolve(configured)
    : join(homedir(), '.dsh')
  return join(root, 'activity-inbox', 'state-v1.json')
}

function payloadSize(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

export function apply(ctx: Context, config: Config = {}): void {
  const statePath = config.statePath === undefined ? defaultStatePath() : resolve(config.statePath)
  const authority = config.authority ?? 'loopback'
  const maxPayloadBytes = config.maxPayloadBytes ?? 16 * 1_024
  const concurrency = config.backfillConcurrency ?? 4
  const store = new ActivityInboxStore(statePath)
  const abort = new AbortController()
  const initialized = store.initialize()

  const observe = (session: Session, event: SessionEvent): void => {
    store.ingestEvent(session.header, event)
  }
  ctx.on('session/event', observe)
  ctx.on('session/created', (session: Session) => { store.noteSession(session.header) })

  // Live sessions include constructor seeds that were never published on the
  // event firehose. Fold them before the asynchronous cold-history scan.
  for (const session of ctx.sessions.list()) store.ingest(session.header, session.events)

  const backfill = initialized.then(async () => {
    let failures = 0
    let headers
    try {
      headers = await ctx.sessionPersistence.list(abort.signal)
    } catch (error) {
      if (!abort.signal.aborted) ctx.logger.warn(`activity-inbox: session listing failed: ${String(error)}`)
      store.markBackfillComplete(abort.signal.aborted ? 0 : 1)
      return
    }
    let cursor = 0
    const worker = async (): Promise<void> => {
      while (!abort.signal.aborted) {
        const index = cursor++
        const header = headers[index]
        if (header === undefined) return
        try {
          const stored = await ctx.sessionPersistence.readFrom(header.id, 0, abort.signal)
          store.ingest(stored.meta, stored.events)
        } catch (error) {
          if (abort.signal.aborted) return
          failures += 1
          ctx.logger.warn(`activity-inbox: backfill failed for session "${header.id}": ${String(error)}`)
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, headers.length)) }, worker))
    if (!abort.signal.aborted) store.markBackfillComplete(failures)
  }).catch((error) => {
    if (!abort.signal.aborted) ctx.logger.error(`activity-inbox: initialization failed: ${String(error)}`)
  })

  const removeRpc = ctx.connection.rpc.handle(ACTIVITY_INBOX_RPC_CHANNEL, async (endpoint, payload) => {
    if (payloadSize(payload) > maxPayloadBytes) {
      return { ok: false, error: { code: 'bad-request', message: 'Activity Inbox payload is too large.', details: { issues: [] } } }
    }
    try {
      await initialized
      if (endpoint === 'snapshot') {
        if (payload !== null && (typeof payload !== 'object' || Array.isArray(payload))) {
          return { ok: false, error: { code: 'bad-request', message: 'Malformed Activity Inbox snapshot request.', details: { issues: [] } } }
        }
        return { ok: true, value: store.snapshot() }
      }
      if (endpoint === 'mutate') {
        if (!isActivityMutation(payload)) {
          return { ok: false, error: { code: 'bad-request', message: 'Malformed Activity Inbox mutation.', details: { issues: [] } } }
        }
        try {
          return { ok: true, value: await store.mutate(payload) }
        } catch (error) {
          return {
            ok: false,
            error: {
              code: 'bad-request',
              message: error instanceof Error ? error.message : 'Activity Inbox mutation failed.',
              details: { issues: [] },
            },
          }
        }
      }
      return { ok: false, error: { code: 'bad-request', message: 'Unknown Activity Inbox endpoint.', details: { issues: [] } } }
    } catch (error) {
      return {
        ok: false,
        error: { code: 'internal', message: error instanceof Error ? error.message : String(error), details: {} },
      }
    }
  }, { authority })

  ctx.effect(() => async () => {
    abort.abort()
    await backfill
    await store.close()
    await removeRpc()
  }, 'activity-inbox: dispose host index and RPC')
}
