/** Transport-neutral protocol for a future local desktop Presence bridge. */

import {
  ACTIVITY_PRESENCE_PROTOCOL_VERSION,
  isActivityPresenceSnapshot,
  type ActivityPresenceSnapshot,
} from '../contracts.js'

export interface PresenceCursor {
  instanceId: string
  revision: number
}

export interface DesktopPetHello {
  appVersion: string
  protocolVersion: 1
  platform: 'darwin'
  arch: 'arm64' | 'x64'
}

export type PresenceClientMessage =
  | {
      type: 'presence/auth'
      version: 1
      token: string
    }
  | {
      type: 'presence/hello'
      version: 1
      client: DesktopPetHello
    }
  | {
      type: 'presence/subscribe'
      version: 1
      cursor?: PresenceCursor
    }

export type PresenceServerMessage =
  | { type: 'presence/welcome'; version: 1; appVersion: string; protocolVersion: 1 }
  | { type: 'presence/control'; version: 1; action: 'quit' }
  | { type: 'presence/snapshot'; version: 1; snapshot: ActivityPresenceSnapshot }
  | { type: 'presence/unchanged'; version: 1; cursor: PresenceCursor }
  | { type: 'presence/error'; version: 1; code: string; message: string }

function safeRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export function isPresenceCursor(value: unknown): value is PresenceCursor {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const input = value as Record<string, unknown>
  return typeof input.instanceId === 'string'
    && input.instanceId.length > 0
    && input.instanceId.length <= 128
    && safeRevision(input.revision)
}

export function isPresenceClientMessage(value: unknown): value is PresenceClientMessage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const input = value as Record<string, unknown>
  if (input.version !== ACTIVITY_PRESENCE_PROTOCOL_VERSION) return false
  switch (input.type) {
    case 'presence/auth':
      return typeof input.token === 'string'
        && input.token.length >= 32
        && input.token.length <= 256
    case 'presence/hello': {
      if (typeof input.client !== 'object' || input.client === null || Array.isArray(input.client)) return false
      const client = input.client as Record<string, unknown>
      return typeof client.appVersion === 'string'
        && client.appVersion.length > 0
        && client.appVersion.length <= 64
        && client.protocolVersion === ACTIVITY_PRESENCE_PROTOCOL_VERSION
        && client.platform === 'darwin'
        && (client.arch === 'arm64' || client.arch === 'x64')
    }
    case 'presence/subscribe':
      return input.cursor === undefined || isPresenceCursor(input.cursor)
    default:
      return false
  }
}

export function isPresenceServerMessage(value: unknown): value is PresenceServerMessage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const input = value as Record<string, unknown>
  if (input.version !== ACTIVITY_PRESENCE_PROTOCOL_VERSION) return false
  switch (input.type) {
    case 'presence/welcome':
      return typeof input.appVersion === 'string'
        && input.appVersion.length > 0
        && input.appVersion.length <= 64
        && input.protocolVersion === ACTIVITY_PRESENCE_PROTOCOL_VERSION
    case 'presence/control':
      return input.action === 'quit'
    case 'presence/snapshot':
      return isActivityPresenceSnapshot(input.snapshot)
    case 'presence/unchanged':
      return isPresenceCursor(input.cursor)
    case 'presence/error':
      return typeof input.code === 'string'
        && input.code.length > 0
        && input.code.length <= 64
        && typeof input.message === 'string'
        && input.message.length <= 500
    default:
      return false
  }
}

export function cursorFor(snapshot: ActivityPresenceSnapshot): PresenceCursor {
  return { instanceId: snapshot.instanceId, revision: snapshot.revision }
}

/**
 * A revision is comparable only within one Host process. A new instance id
 * deliberately accepts a lower revision after Host restart.
 */
export function shouldAcceptPresence(
  current: PresenceCursor | undefined,
  incoming: ActivityPresenceSnapshot,
): boolean {
  return current === undefined
    || current.instanceId !== incoming.instanceId
    || incoming.revision > current.revision
}

/** Build the first response for a subscription or reconnect handshake. */
export function synchronizePresence(
  snapshot: ActivityPresenceSnapshot,
  cursor: PresenceCursor | undefined,
): PresenceServerMessage {
  if (cursor !== undefined
    && cursor.instanceId === snapshot.instanceId
    && cursor.revision === snapshot.revision) {
    return {
      type: 'presence/unchanged',
      version: ACTIVITY_PRESENCE_PROTOCOL_VERSION,
      cursor: cursorFor(snapshot),
    }
  }
  return {
    type: 'presence/snapshot',
    version: ACTIVITY_PRESENCE_PROTOCOL_VERSION,
    snapshot,
  }
}
