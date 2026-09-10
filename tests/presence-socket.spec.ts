import { lstat, mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { createConnection, type Socket } from 'node:net'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ActivityPresenceSnapshot } from '../src/contracts.js'
import type { PresenceCredentialProvider } from '../src/presence/keychain.js'
import {
  createPresenceSocketBridge,
  type PresenceSocketBridge,
  type PresenceSnapshotSource,
} from '../src/presence/socket.js'

const TOKEN = 't'.repeat(43)
const roots: string[] = []
const bridges: PresenceSocketBridge[] = []
const sockets: Socket[] = []

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy()
  await Promise.all(bridges.splice(0).map(bridge => bridge.close()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

class TestSource implements PresenceSnapshotSource {
  private revision = 0
  private readonly listeners = new Set<(snapshot: ActivityPresenceSnapshot) => void>()

  presence(): ActivityPresenceSnapshot {
    return {
      version: 1,
      instanceId: 'host-test',
      revision: this.revision,
      generatedAt: 1_000 + this.revision,
      ready: true,
      backfillFailures: 0,
      activities: [],
    }
  }

  subscribePresence(listener: (snapshot: ActivityPresenceSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  publish(): void {
    this.revision += 1
    const snapshot = this.presence()
    for (const listener of this.listeners) listener(snapshot)
  }
}

class LineReader {
  private buffer = ''
  private readonly lines: string[] = []
  private readonly waiters: Array<(line: string) => void> = []

  constructor(socket: Socket) {
    socket.setEncoding('utf8')
    socket.on('data', chunk => {
      this.buffer += chunk
      let newline = this.buffer.indexOf('\n')
      while (newline >= 0) {
        const line = this.buffer.slice(0, newline)
        this.buffer = this.buffer.slice(newline + 1)
        const waiter = this.waiters.shift()
        if (waiter === undefined) this.lines.push(line)
        else waiter(line)
        newline = this.buffer.indexOf('\n')
      }
    })
  }

  next(): Promise<Record<string, unknown>> {
    const queued = this.lines.shift()
    if (queued !== undefined) return Promise.resolve(JSON.parse(queued) as Record<string, unknown>)
    return new Promise((resolveLine, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for Presence frame.')), 2_000)
      this.waiters.push(line => {
        clearTimeout(timer)
        resolveLine(JSON.parse(line) as Record<string, unknown>)
      })
    })
  }
}

function credentials(): PresenceCredentialProvider {
  return {
    descriptor: { service: 'test-service', account: 'test-account' },
    async getOrCreateToken() {
      return TOKEN
    },
  }
}

async function socketFixture(source = new TestSource()): Promise<{
  bridge: PresenceSocketBridge
  source: TestSource
  root: string
}> {
  const root = await mkdtemp('/tmp/dsh-presence-')
  roots.push(root)
  const bridge = await createPresenceSocketBridge({
    socketPath: join(root, 'presence.sock'),
    credentials: credentials(),
    source,
    authTimeoutMs: 500,
    maxInboundFrameBytes: 1_024,
    expectedClientVersion: '0.1.0',
  })
  bridges.push(bridge)
  return { bridge, source, root }
}

function connect(socketPath: string): Promise<Socket> {
  return new Promise((resolveSocket, reject) => {
    const socket = createConnection(socketPath)
    socket.once('connect', () => {
      sockets.push(socket)
      resolveSocket(socket)
    })
    socket.once('error', reject)
  })
}

function send(socket: Socket, value: unknown): void {
  socket.write(`${JSON.stringify(value)}\n`)
}

describe('Presence Unix socket bridge', () => {
  it('creates a private socket and pushes revisions after authentication', async () => {
    const { bridge, source, root } = await socketFixture()
    expect((await lstat(root)).mode & 0o777).toBe(0o700)
    expect((await stat(bridge.socketPath)).mode & 0o777).toBe(0o600)

    const socket = await connect(bridge.socketPath)
    const reader = new LineReader(socket)
    send(socket, { type: 'presence/auth', version: 1, token: TOKEN })
    send(socket, {
      type: 'presence/hello',
      version: 1,
      client: {
        appVersion: '0.1.0',
        protocolVersion: 1,
        platform: 'darwin',
        arch: 'arm64',
      },
    })
    send(socket, {
      type: 'presence/subscribe',
      version: 1,
      cursor: { instanceId: 'host-test', revision: 0 },
    })
    await expect(reader.next()).resolves.toMatchObject({
      type: 'presence/welcome',
      appVersion: '0.1.0',
      protocolVersion: 1,
    })
    await expect(reader.next()).resolves.toMatchObject({
      type: 'presence/unchanged',
      cursor: { instanceId: 'host-test', revision: 0 },
    })

    source.publish()
    await expect(reader.next()).resolves.toMatchObject({
      type: 'presence/snapshot',
      snapshot: { instanceId: 'host-test', revision: 1 },
    })
    expect(bridge.control('quit')).toBe(true)
    await expect(reader.next()).resolves.toMatchObject({
      type: 'presence/control',
      action: 'quit',
    })
  })

  it('rejects a desktop build that does not match the Host version contract', async () => {
    const { bridge } = await socketFixture()
    const socket = await connect(bridge.socketPath)
    const reader = new LineReader(socket)
    send(socket, { type: 'presence/auth', version: 1, token: TOKEN })
    send(socket, {
      type: 'presence/hello',
      version: 1,
      client: {
        appVersion: '9.9.9',
        protocolVersion: 1,
        platform: 'darwin',
        arch: 'arm64',
      },
    })
    await expect(reader.next()).resolves.toMatchObject({
      type: 'presence/error',
      code: 'incompatible-client',
    })
  })

  it('rejects unauthenticated and incorrect credentials without exposing tokens', async () => {
    const { bridge } = await socketFixture()
    const unauthenticated = await connect(bridge.socketPath)
    const unauthenticatedReader = new LineReader(unauthenticated)
    send(unauthenticated, { type: 'presence/subscribe', version: 1 })
    await expect(unauthenticatedReader.next()).resolves.toMatchObject({
      type: 'presence/error',
      code: 'auth-required',
    })

    const rejected = await connect(bridge.socketPath)
    const rejectedReader = new LineReader(rejected)
    const wrongToken = 'x'.repeat(43)
    send(rejected, { type: 'presence/auth', version: 1, token: wrongToken })
    const response = await rejectedReader.next()
    expect(response).toMatchObject({ type: 'presence/error', code: 'auth-failed' })
    expect(JSON.stringify(response)).not.toContain(TOKEN)
    expect(JSON.stringify(response)).not.toContain(wrongToken)
  })

  it('closes oversized requests at the configured boundary', async () => {
    const { bridge } = await socketFixture()
    const socket = await connect(bridge.socketPath)
    const reader = new LineReader(socket)
    socket.write('x'.repeat(1_025))
    await expect(reader.next()).resolves.toMatchObject({
      type: 'presence/error',
      code: 'frame-too-large',
    })
  })

  it('closes clients that do not authenticate before the deadline', async () => {
    const root = await mkdtemp('/tmp/dsh-presence-')
    roots.push(root)
    const bridge = await createPresenceSocketBridge({
      socketPath: join(root, 'presence.sock'),
      credentials: credentials(),
      source: new TestSource(),
      authTimeoutMs: 100,
    })
    bridges.push(bridge)
    const socket = await connect(bridge.socketPath)

    await expect(new Promise<void>((resolveClose, reject) => {
      const timer = setTimeout(() => reject(new Error('Socket did not close.')), 2_000)
      socket.once('close', () => {
        clearTimeout(timer)
        resolveClose()
      })
    })).resolves.toBeUndefined()
  })

  it('does not unlink an active server and removes only its own socket on close', async () => {
    const { bridge, source } = await socketFixture()
    await expect(createPresenceSocketBridge({
      socketPath: bridge.socketPath,
      credentials: credentials(),
      source,
    })).rejects.toThrow('already active')
    expect((await stat(bridge.socketPath)).isSocket()).toBe(true)

    await bridge.close()
    bridges.splice(bridges.indexOf(bridge), 1)
    await expect(lstat(bridge.socketPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves a replacement path that no longer targets this Host', async () => {
    const { bridge } = await socketFixture()
    await unlink(bridge.socketPath)
    await writeFile(bridge.socketPath, 'replacement', 'utf8')

    await bridge.close()
    bridges.splice(bridges.indexOf(bridge), 1)
    await expect(readFile(bridge.socketPath, 'utf8')).resolves.toBe('replacement')
  })
})
