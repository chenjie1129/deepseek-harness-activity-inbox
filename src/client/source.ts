/** Small observable around the generic Connection RPC channel. */

import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import {
  ACTIVITY_INBOX_RPC_CHANNEL,
  type ActivityInboxSnapshot,
  type ActivityMutation,
} from '../contracts.js'

export interface ActivityInboxClientSnapshot {
  server?: ActivityInboxSnapshot
  loading: boolean
  error?: string
}

export interface ActivityInboxSource extends HostObservable<ActivityInboxClientSnapshot> {
  refresh(): void
  reset(): void
  mutate(mutation: ActivityMutation): Promise<{ ok: true } | { ok: false; message: string }>
}

function isSnapshot(value: unknown): value is ActivityInboxSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const input = value as Record<string, unknown>
  return input.version === 1
    && typeof input.revision === 'number'
    && typeof input.backfillReady === 'boolean'
    && typeof input.backfillFailures === 'number'
    && Array.isArray(input.activities)
    && Array.isArray(input.preferences)
}

export function createActivityInboxSource(
  connection: ConnectionHandle,
  onError: (error: unknown) => void,
): ActivityInboxSource {
  const listeners = new Set<() => void>()
  let snapshot: ActivityInboxClientSnapshot = { loading: false }
  let generation = 0
  let inFlight: Promise<void> | undefined

  const publish = (next: ActivityInboxClientSnapshot): void => {
    snapshot = next
    for (const listener of [...listeners]) listener()
  }

  const read = async (readGeneration: number): Promise<void> => {
    try {
      const result = await connection.rpc.call(ACTIVITY_INBOX_RPC_CHANNEL, 'snapshot', {})
      if (readGeneration !== generation) return
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      if (!isSnapshot(result.value)) throw new Error('Host returned a malformed Activity Inbox snapshot.')
      publish({ server: result.value, loading: false })
    } catch (error) {
      if (readGeneration !== generation) return
      onError(error)
      publish({
        ...snapshot.server === undefined ? {} : { server: snapshot.server },
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      if (readGeneration === generation) inFlight = undefined
    }
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    refresh() {
      if (inFlight !== undefined) return
      const readGeneration = generation
      publish({
        ...snapshot.server === undefined ? {} : { server: snapshot.server },
        loading: true,
        ...snapshot.error === undefined ? {} : { error: snapshot.error },
      })
      inFlight = read(readGeneration)
    },
    reset() {
      generation += 1
      inFlight = undefined
      publish({ loading: false })
    },
    async mutate(mutation) {
      try {
        const result = await connection.rpc.call(ACTIVITY_INBOX_RPC_CHANNEL, 'mutate', mutation)
        if (!result.ok) return { ok: false, message: `${result.error.code}: ${result.error.message}` }
        if (!isSnapshot(result.value)) return { ok: false, message: 'Host returned a malformed Activity Inbox snapshot.' }
        publish({ server: result.value, loading: false })
        return { ok: true }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}
