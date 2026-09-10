import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmod, lstat, mkdir, readlink, symlink, unlink } from 'node:fs/promises'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { basename, dirname, join, resolve } from 'node:path'
import {
  ACTIVITY_PRESENCE_PROTOCOL_VERSION,
  type ActivityPresenceSnapshot,
} from '../contracts.js'
import {
  isPresenceClientMessage,
  synchronizePresence,
  type DesktopPetHello,
  type PresenceServerMessage,
} from './protocol.js'
import type {
  PresenceCredentialDescriptor,
  PresenceCredentialProvider,
} from './keychain.js'

const DEFAULT_AUTH_TIMEOUT_MS = 5_000
const DEFAULT_MAX_CLIENTS = 8
const DEFAULT_MAX_INBOUND_FRAME_BYTES = 16 * 1024
const DEFAULT_MAX_OUTBOUND_FRAME_BYTES = 8 * 1024 * 1024
const MAX_SOCKET_PATH_BYTES = 100

export interface PresenceSnapshotSource {
  presence(): ActivityPresenceSnapshot
  subscribePresence(listener: (snapshot: ActivityPresenceSnapshot) => void): () => void
}

export interface PresenceSocketOptions {
  socketPath: string
  credentials: PresenceCredentialProvider
  source: PresenceSnapshotSource
  authTimeoutMs?: number
  maxClients?: number
  maxInboundFrameBytes?: number
  maxOutboundFrameBytes?: number
  expectedClientVersion?: string
  onClientHello?: (client: DesktopPetHello) => void
  onClientDisconnect?: (client: DesktopPetHello) => void
}

export interface PresenceSocketBridge {
  readonly socketPath: string
  readonly credential: PresenceCredentialDescriptor
  control(action: 'quit'): boolean
  close(): Promise<void>
}

interface ClientState {
  socket: Socket
  buffer: string
  authenticated: boolean
  greeted: boolean
  subscribed: boolean
  hello?: DesktopPetHello
  instanceId?: string
  revision?: number
}

function protocolError(code: string, message: string): PresenceServerMessage {
  return {
    type: 'presence/error',
    version: ACTIVITY_PRESENCE_PROTOCOL_VERSION,
    code,
    message,
  }
}

function tokenMatches(expected: string, candidate: string): boolean {
  const expectedDigest = createHash('sha256').update(expected).digest()
  const candidateDigest = createHash('sha256').update(candidate).digest()
  return timingSafeEqual(expectedDigest, candidateDigest)
}

function encodeMessage(
  message: PresenceServerMessage,
  maxBytes: number,
): string | undefined {
  const frame = `${JSON.stringify(message)}\n`
  return Buffer.byteLength(frame) <= maxBytes ? frame : undefined
}

function writeMessage(
  client: ClientState,
  message: PresenceServerMessage,
  maxBytes: number,
): boolean {
  const frame = encodeMessage(message, maxBytes)
  if (frame === undefined) return false
  if (client.socket.writableLength + Buffer.byteLength(frame) > maxBytes * 2) return false
  client.socket.write(frame)
  return true
}

async function socketIsActive(socketPath: string): Promise<boolean> {
  return new Promise((resolveActive, reject) => {
    const socket = createConnection(socketPath)
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`Timed out probing existing Presence socket at ${socketPath}.`))
    }, 500)
    socket.once('connect', () => {
      clearTimeout(timer)
      socket.destroy()
      resolveActive(true)
    })
    socket.once('error', error => {
      clearTimeout(timer)
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ECONNREFUSED' || code === 'ENOENT') resolveActive(false)
      else reject(error)
    })
  })
}

async function prepareSocketPath(socketPath: string): Promise<void> {
  if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) {
    throw new Error(`Presence socket path exceeds ${MAX_SOCKET_PATH_BYTES} bytes.`)
  }
  const directory = dirname(socketPath)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const directoryStat = await lstat(directory)
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error('Presence socket directory must be a real directory.')
  }
  if (typeof process.getuid === 'function' && directoryStat.uid !== process.getuid()) {
    throw new Error('Presence socket directory must be owned by the current user.')
  }
  await chmod(directory, 0o700)

  let existing
  try {
    existing = await lstat(socketPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (!existing.isSocket() && !existing.isSymbolicLink()) {
    throw new Error('Presence socket path exists and is not a Unix socket.')
  }
  if (await socketIsActive(socketPath)) {
    throw new Error('A Presence socket server is already active.')
  }
  if (existing.isSymbolicLink()) {
    const target = resolve(dirname(socketPath), await readlink(socketPath))
    await unlink(socketPath)
    if (dirname(target) !== dirname(socketPath)
      || !basename(target).startsWith('.presence-')) return
    try {
      const targetStat = await lstat(target)
      if (targetStat.isSocket()) await unlink(target)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return
  }
  await unlink(socketPath)
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolveListen, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      resolveListen()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(socketPath)
  })
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolveClose, reject) => {
    server.close(error => {
      if (error === undefined) resolveClose()
      else reject(error)
    })
  })
}

async function unlinkOwnedEndpoint(socketPath: string, boundSocketPath: string): Promise<void> {
  try {
    const target = await readlink(socketPath)
    if (resolve(dirname(socketPath), target) === boundSocketPath) {
      await unlink(socketPath)
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'EINVAL') throw error
  }
}

export async function createPresenceSocketBridge(
  options: PresenceSocketOptions,
): Promise<PresenceSocketBridge> {
  const socketPath = resolve(options.socketPath)
  const authTimeoutMs = options.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS
  const maxClients = options.maxClients ?? DEFAULT_MAX_CLIENTS
  const maxInboundFrameBytes = options.maxInboundFrameBytes ?? DEFAULT_MAX_INBOUND_FRAME_BYTES
  const maxOutboundFrameBytes = options.maxOutboundFrameBytes ?? DEFAULT_MAX_OUTBOUND_FRAME_BYTES
  if (!Number.isSafeInteger(authTimeoutMs) || authTimeoutMs < 100 || authTimeoutMs > 60_000) {
    throw new Error('Presence auth timeout must be between 100 and 60000 ms.')
  }
  if (!Number.isSafeInteger(maxClients) || maxClients < 1 || maxClients > 64) {
    throw new Error('Presence max clients must be between 1 and 64.')
  }
  if (!Number.isSafeInteger(maxInboundFrameBytes)
    || maxInboundFrameBytes < 1_024
    || maxInboundFrameBytes > 1024 * 1024) {
    throw new Error('Presence inbound frame limit must be between 1 KiB and 1 MiB.')
  }
  if (!Number.isSafeInteger(maxOutboundFrameBytes)
    || maxOutboundFrameBytes < 64 * 1024
    || maxOutboundFrameBytes > 16 * 1024 * 1024) {
    throw new Error('Presence outbound frame limit must be between 64 KiB and 16 MiB.')
  }

  const token = await options.credentials.getOrCreateToken()
  if (token.length < 32 || token.length > 256) {
    throw new Error('Presence credential provider returned an invalid token.')
  }
  await prepareSocketPath(socketPath)
  const boundSocketPath = join(
    dirname(socketPath),
    `.presence-${randomUUID().replaceAll('-', '')}.sock`,
  )
  if (Buffer.byteLength(boundSocketPath) > MAX_SOCKET_PATH_BYTES) {
    throw new Error(`Presence bound socket path exceeds ${MAX_SOCKET_PATH_BYTES} bytes.`)
  }

  const clients = new Set<ClientState>()
  const server = createServer(socket => {
    if (clients.size >= maxClients) {
      socket.destroy()
      return
    }
    socket.setEncoding('utf8')
    socket.setNoDelay(true)
    const client: ClientState = {
      socket,
      buffer: '',
      authenticated: false,
      greeted: false,
      subscribed: false,
    }
    clients.add(client)
    const authTimer = setTimeout(() => {
      if (!client.authenticated) socket.destroy()
    }, authTimeoutMs)

    const closeWith = (code: string, message: string): void => {
      writeMessage(client, protocolError(code, message), maxOutboundFrameBytes)
      socket.end()
    }

    socket.on('data', chunk => {
      client.buffer += chunk
      if (Buffer.byteLength(client.buffer) > maxInboundFrameBytes) {
        closeWith('frame-too-large', 'Presence request exceeds the configured frame limit.')
        return
      }
      let newline = client.buffer.indexOf('\n')
      while (newline >= 0 && !socket.destroyed) {
        const line = client.buffer.slice(0, newline)
        client.buffer = client.buffer.slice(newline + 1)
        if (Buffer.byteLength(line) > maxInboundFrameBytes) {
          closeWith('frame-too-large', 'Presence request exceeds the configured frame limit.')
          return
        }
        let raw: unknown
        try {
          raw = JSON.parse(line)
        } catch {
          closeWith('bad-message', 'Presence request must be valid NDJSON.')
          return
        }
        if (!isPresenceClientMessage(raw)) {
          closeWith('bad-message', 'Presence request does not match protocol version 1.')
          return
        }
        if (!client.authenticated) {
          if (raw.type !== 'presence/auth') {
            closeWith('auth-required', 'Authenticate before subscribing.')
            return
          }
          if (!tokenMatches(token, raw.token)) {
            closeWith('auth-failed', 'Presence authentication failed.')
            return
          }
          client.authenticated = true
          clearTimeout(authTimer)
          socket.setTimeout(0)
        } else if (raw.type === 'presence/auth') {
          closeWith('bad-state', 'Presence connection is already authenticated.')
          return
        } else if (!client.greeted) {
          if (raw.type !== 'presence/hello') {
            closeWith('hello-required', 'Complete the desktop version handshake before subscribing.')
            return
          }
          if (options.expectedClientVersion !== undefined
            && raw.client.appVersion !== options.expectedClientVersion) {
            closeWith(
              'incompatible-client',
              `Activity Pet ${options.expectedClientVersion} is required.`,
            )
            return
          }
          client.greeted = true
          client.hello = raw.client
          options.onClientHello?.(raw.client)
          if (!writeMessage(client, {
            type: 'presence/welcome',
            version: ACTIVITY_PRESENCE_PROTOCOL_VERSION,
            appVersion: options.expectedClientVersion ?? raw.client.appVersion,
            protocolVersion: ACTIVITY_PRESENCE_PROTOCOL_VERSION,
          }, maxOutboundFrameBytes)) {
            closeWith('frame-too-large', 'Presence welcome exceeds the configured frame limit.')
            return
          }
        } else if (raw.type === 'presence/subscribe') {
          const snapshot = options.source.presence()
          const response = synchronizePresence(snapshot, raw.cursor)
          if (!writeMessage(client, response, maxOutboundFrameBytes)) {
            closeWith('frame-too-large', 'Presence snapshot exceeds the configured frame limit.')
            return
          }
          client.subscribed = true
          client.instanceId = snapshot.instanceId
          client.revision = snapshot.revision
        } else {
          closeWith('bad-state', 'Presence handshake is already complete.')
          return
        }
        newline = client.buffer.indexOf('\n')
      }
    })
    socket.on('error', () => {})
    socket.on('close', () => {
      clearTimeout(authTimer)
      clients.delete(client)
      if (client.hello !== undefined) options.onClientDisconnect?.(client.hello)
    })
  })
  server.maxConnections = maxClients

  try {
    await listen(server, boundSocketPath)
    await chmod(boundSocketPath, 0o600)
    await symlink(basename(boundSocketPath), socketPath)
  } catch (error) {
    await unlinkOwnedEndpoint(socketPath, boundSocketPath)
    await closeServer(server)
    await unlink(boundSocketPath).catch(() => {})
    throw error
  }

  const unsubscribe = options.source.subscribePresence(snapshot => {
    for (const client of clients) {
      if (!client.authenticated || !client.subscribed) continue
      if (client.instanceId === snapshot.instanceId && client.revision === snapshot.revision) continue
      const sent = writeMessage(client, {
        type: 'presence/snapshot',
        version: ACTIVITY_PRESENCE_PROTOCOL_VERSION,
        snapshot,
      }, maxOutboundFrameBytes)
      if (!sent) {
        client.socket.destroy()
        continue
      }
      client.instanceId = snapshot.instanceId
      client.revision = snapshot.revision
    }
  })

  let closed = false
  return {
    socketPath,
    credential: options.credentials.descriptor,
    control(action: 'quit'): boolean {
      let sent = false
      for (const client of clients) {
        if (!client.authenticated || !client.greeted) continue
        sent = writeMessage(client, {
          type: 'presence/control',
          version: ACTIVITY_PRESENCE_PROTOCOL_VERSION,
          action,
        }, maxOutboundFrameBytes) || sent
      }
      return sent
    },
    async close(): Promise<void> {
      if (closed) return
      closed = true
      unsubscribe()
      for (const client of clients) client.socket.destroy()
      await unlinkOwnedEndpoint(socketPath, boundSocketPath)
      await closeServer(server)
      await unlink(boundSocketPath).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      })
    },
  }
}
