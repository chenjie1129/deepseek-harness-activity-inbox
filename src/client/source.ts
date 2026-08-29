/** Small observable around the generic Connection RPC channel. */

import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import {
  ACTIVITY_INBOX_RPC_CHANNEL,
  isActivityInboxSnapshot,
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

interface ActivityInboxRpcResult {
  ok: boolean
  value?: unknown
  error?: { code: string; message: string }
}

export interface ActivityInboxTransport {
  snapshot(): Promise<ActivityInboxRpcResult>
  mutate(mutation: ActivityMutation): Promise<ActivityInboxRpcResult>
}

export interface ActivityInboxRemoteNamespace {
  snapshot(): Promise<ActivityInboxRpcResult>
  mutate(mutation: ActivityMutation): Promise<ActivityInboxRpcResult>
}

/** Preserve the legacy carrier for 0.1.1-rc.2 profiles. */
export function createConnectionActivityInboxTransport(connection: ConnectionHandle): ActivityInboxTransport {
  return {
    snapshot: () => connection.rpc.call(ACTIVITY_INBOX_RPC_CHANNEL, 'snapshot', {}),
    mutate: mutation => connection.rpc.call(ACTIVITY_INBOX_RPC_CHANNEL, 'mutate', mutation),
  }
}

/** Use the supported Remote namespace on 0.1.2-alpha.1 and newer profiles. */
export function createRemoteActivityInboxTransport(remote: ActivityInboxRemoteNamespace): ActivityInboxTransport {
  return {
    snapshot: () => remote.snapshot(),
    mutate: mutation => remote.mutate(mutation),
  }
}

function isTransport(value: ActivityInboxTransport | ConnectionHandle): value is ActivityInboxTransport {
  return typeof Reflect.get(value as object, 'snapshot') === 'function'
    && typeof Reflect.get(value as object, 'mutate') === 'function'
}

export function createActivityInboxSource(
  input: ActivityInboxTransport | ConnectionHandle,
  onError: (error: unknown) => void,
): ActivityInboxSource {
  const transport = isTransport(input) ? input : createConnectionActivityInboxTransport(input)
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
      const result = await transport.snapshot()
      if (readGeneration !== generation) return
      if (!result.ok) throw new Error(`${result.error?.code ?? 'internal'}: ${result.error?.message ?? 'Activity Inbox request failed.'}`)
      if (!isActivityInboxSnapshot(result.value)) throw new Error('Host returned a malformed Activity Inbox snapshot.')
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
        const result = await transport.mutate(mutation)
        if (!result.ok) return { ok: false, message: `${result.error?.code ?? 'internal'}: ${result.error?.message ?? 'Activity Inbox mutation failed.'}` }
        if (!isActivityInboxSnapshot(result.value)) return { ok: false, message: 'Host returned a malformed Activity Inbox snapshot.' }
        publish({ server: result.value, loading: false })
        return { ok: true }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}
