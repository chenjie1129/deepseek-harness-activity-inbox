/** DeepSeek Harness Host half: durable event backfill, preference store, and RPC. */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-user-approval'
import z from '@deepseek-ai/schemastery'
import {
  ACTIVITY_INBOX_RPC_CHANNEL,
  isActivityMutation,
  type ActivityInboxSnapshot,
  type ActivityMutation,
} from './contracts.js'
import {
  ACTIVITY_INBOX_HOST_CONTRIBUTION,
  ACTIVITY_INBOX_REMOTE_NAMESPACE,
  ACTIVITY_INBOX_REMOTE_SERVICE,
} from './remote.js'
import { observeApprovalPresence } from './presence/approval.js'
import {
  DEFAULT_PRESENCE_KEYCHAIN_SERVICE,
  MacOSKeychainCredentialProvider,
} from './presence/keychain.js'
import { createPresenceSocketBridge } from './presence/socket.js'
import { ActivityInboxStore } from './store.js'

export * from './contracts.js'
export * from './presence/host.js'
export * from './presence/projector.js'
export * from './presence/protocol.js'
export { ActivityInboxStore } from './store.js'

export const name = 'activity-inbox'
export const inject = ['sessions', 'sessionPersistence', 'connection']

export interface Config {
  statePath?: string
  authority?: 'loopback' | 'trusted-host'
  maxPayloadBytes?: number
  backfillConcurrency?: number
  presenceSocketEnabled?: boolean
  presenceSocketPath?: string
  presenceKeychainService?: string
  presenceKeychainAccount?: string
  presenceAuthTimeoutMs?: number
  presenceMaxClients?: number
}

export const Config: z<Config> = z.object({
  statePath: z.string(),
  authority: z.union(['loopback', 'trusted-host'] as const).default('loopback'),
  maxPayloadBytes: z.natural().min(1_024).default(16 * 1_024),
  backfillConcurrency: z.natural().min(1).max(16).default(4),
  presenceSocketEnabled: z.boolean().default(process.platform === 'darwin'),
  presenceSocketPath: z.string(),
  presenceKeychainService: z.string(),
  presenceKeychainAccount: z.string(),
  presenceAuthTimeoutMs: z.natural().min(100).max(60_000).default(5_000),
  presenceMaxClients: z.natural().min(1).max(64).default(8),
})

function defaultDataRoot(): string {
  const configured = process.env.DSH_HOME
  return configured !== undefined && configured.trim().length > 0
    ? resolve(configured)
    : join(homedir(), '.dsh')
}

function defaultStatePath(): string {
  return join(defaultDataRoot(), 'activity-inbox', 'state-v1.json')
}

function defaultPresenceSocketPath(): string {
  return join(defaultDataRoot(), 'activity-inbox', 'presence-v1.sock')
}

function payloadSize(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

interface TypertRegistryLike {
  register(contribution: typeof ACTIVITY_INBOX_HOST_CONTRIBUTION): () => Promise<void>
}

interface ActivityInboxRemoteService {
  typertRemote: {
    readonly service: ActivityInboxRemoteService
    readonly serviceKey: typeof ACTIVITY_INBOX_REMOTE_SERVICE
    readonly namespace: typeof ACTIVITY_INBOX_REMOTE_NAMESPACE
  }
  snapshot(): Promise<ActivityInboxSnapshot>
  mutate(mutation: ActivityMutation): Promise<ActivityInboxSnapshot>
}

interface RemoteInstallation {
  dispose(): Promise<void>
}

function installRemote(
  ctx: Context,
  store: ActivityInboxStore,
  initialized: Promise<void>,
  maxPayloadBytes: number,
): RemoteInstallation | undefined {
  const typert = ctx.get('typert') as TypertRegistryLike | undefined
  if (typeof typert?.register !== 'function') return undefined

  const service = {
    async snapshot(): Promise<ActivityInboxSnapshot> {
      await initialized
      return store.snapshot()
    },
    async mutate(mutation: ActivityMutation): Promise<ActivityInboxSnapshot> {
      if (payloadSize(mutation) > maxPayloadBytes) throw new Error('Activity Inbox payload is too large.')
      if (!isActivityMutation(mutation)) throw new Error('Malformed Activity Inbox mutation.')
      await initialized
      return store.mutate(mutation)
    },
  } as ActivityInboxRemoteService
  service.typertRemote = Object.freeze({
    service,
    serviceKey: ACTIVITY_INBOX_REMOTE_SERVICE,
    namespace: ACTIVITY_INBOX_REMOTE_NAMESPACE,
  })

  const removeService = ctx.provide(ACTIVITY_INBOX_REMOTE_SERVICE, service)
  let removeContribution: (() => Promise<void>) | undefined
  try {
    removeContribution = typert.register(ACTIVITY_INBOX_HOST_CONTRIBUTION)
  } catch (error) {
    void removeService()
    throw error
  }
  return {
    async dispose(): Promise<void> {
      await removeContribution?.()
      await removeService()
    },
  }
}

export function apply(ctx: Context, config: Config = {}): void {
  const statePath = config.statePath === undefined ? defaultStatePath() : resolve(config.statePath)
  const authority = config.authority ?? 'loopback'
  const maxPayloadBytes = config.maxPayloadBytes ?? 16 * 1_024
  const concurrency = config.backfillConcurrency ?? 4
  const presenceSocketEnabled = config.presenceSocketEnabled ?? process.platform === 'darwin'
  const presenceSocketPath = config.presenceSocketPath === undefined
    ? defaultPresenceSocketPath()
    : resolve(config.presenceSocketPath)
  const store = new ActivityInboxStore(statePath)
  const abort = new AbortController()
  const initialized = store.initialize()

  const observe = (session: Session, event: SessionEvent): void => {
    store.ingestEvent(session.header, event)
  }
  ctx.on('session/event', observe)
  ctx.on('session/created', (session: Session) => { store.noteSession(session.header) })
  ctx.on('approval/request', (request, next) => observeApprovalPresence(store, request, next), { prepend: true })

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

  const presenceBridge = presenceSocketEnabled
    ? initialized.then(() => createPresenceSocketBridge({
        socketPath: presenceSocketPath,
        source: store,
        credentials: new MacOSKeychainCredentialProvider({
          socketPath: presenceSocketPath,
          ...config.presenceKeychainService === undefined
            ? { service: DEFAULT_PRESENCE_KEYCHAIN_SERVICE }
            : { service: config.presenceKeychainService },
          ...config.presenceKeychainAccount === undefined
            ? {}
            : { account: config.presenceKeychainAccount },
        }),
        authTimeoutMs: config.presenceAuthTimeoutMs ?? 5_000,
        maxClients: config.presenceMaxClients ?? 8,
        maxInboundFrameBytes: maxPayloadBytes,
      }))
      .catch(error => {
        ctx.logger.error(`activity-inbox: Presence socket failed: ${String(error)}`)
        return undefined
      })
    : Promise.resolve(undefined)

  const remote = installRemote(ctx, store, initialized, maxPayloadBytes)
  const removeRpc = remote === undefined ? ctx.connection.rpc.handle(ACTIVITY_INBOX_RPC_CHANNEL, async (endpoint, payload) => {
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
  }, { authority }) : undefined

  ctx.effect(() => async () => {
    abort.abort()
    await (await presenceBridge)?.close()
    await remote?.dispose()
    await removeRpc?.()
    await backfill
    await store.close()
  }, 'activity-inbox: dispose host index and transport')
}
