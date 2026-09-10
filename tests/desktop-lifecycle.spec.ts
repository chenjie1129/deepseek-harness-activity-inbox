import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { DesktopPetLifecycle } from '../src/desktop/lifecycle.js'

class FakeChild extends EventEmitter {
  pid = 1234
  exitCode: number | null = null
  killed = false

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = true
    queueMicrotask(() => {
      this.exitCode = 0
      this.emit('exit', 0, signal === 'SIGTERM' ? 'SIGTERM' : null)
    })
    return true
  }
}

function lifecycle(overrides: Partial<ConstructorParameters<typeof DesktopPetLifecycle>[0]> = {}) {
  const child = new FakeChild()
  const spawnProcess = vi.fn(() => {
    queueMicrotask(() => { child.emit('spawn') })
    return child as unknown as ChildProcess
  })
  const manager = new DesktopPetLifecycle({
    enabled: true,
    autoStart: false,
    stopOnHostExit: true,
    executablePath: '/Applications/Activity Pet.app',
    searchRoots: [],
    environment: { DSH_HOME: '/tmp/dsh' },
    platform: 'darwin',
    accessExecutable: vi.fn(async () => {}),
    spawnProcess,
    ...overrides,
  })
  return { child, manager, spawnProcess }
}

describe('Desktop Pet lifecycle', () => {
  it('discovers an app bundle and owns start and stop transitions', async () => {
    const { child, manager, spawnProcess } = lifecycle()

    await expect(manager.initialize()).resolves.toMatchObject({
      phase: 'stopped',
      available: true,
      managed: false,
    })
    await expect(manager.control({ action: 'start' })).resolves.toMatchObject({
      phase: 'running',
      managed: true,
    })
    expect(spawnProcess).toHaveBeenCalledWith(
      '/Applications/Activity Pet.app/Contents/MacOS/activity-pet',
      [],
      expect.objectContaining({ stdio: 'ignore' }),
    )

    await expect(manager.control({ action: 'stop' })).resolves.toMatchObject({
      phase: 'stopped',
    })
    expect(child.killed).toBe(true)
    expect(manager.snapshot()).toMatchObject({ phase: 'stopped', managed: false })
  })

  it('reports unavailable without spawning when no executable can be found', async () => {
    const { manager, spawnProcess } = lifecycle({
      executablePath: '/missing/Activity Pet.app',
      searchRoots: ['/missing'],
      accessExecutable: vi.fn(async () => { throw new Error('missing') }),
    })

    await expect(manager.initialize()).resolves.toMatchObject({
      phase: 'unavailable',
      available: false,
      managed: false,
    })
    await expect(manager.control({ action: 'start' })).resolves.toMatchObject({
      phase: 'unavailable',
    })
    expect(spawnProcess).not.toHaveBeenCalled()
  })

  it('fails closed when an explicitly required artifact is invalid', async () => {
    const { manager, spawnProcess } = lifecycle({
      artifactRoots: ['/missing/platform-package'],
      artifactRequired: true,
      installRoot: '/tmp/activity-pet-required-artifact',
    })

    await expect(manager.initialize()).resolves.toMatchObject({
      phase: 'error',
      available: false,
      managed: false,
    })
    expect(spawnProcess).not.toHaveBeenCalled()
  })

  it('auto-starts only after executable discovery succeeds', async () => {
    const { manager } = lifecycle({ autoStart: true })

    await expect(manager.initialize()).resolves.toMatchObject({
      phase: 'running',
      available: true,
      managed: true,
      autoStart: true,
    })
  })

  it('adopts a compatible connected instance without spawning a duplicate', async () => {
    const { manager, spawnProcess } = lifecycle()
    const control = vi.fn(() => true)
    await manager.initialize()
    manager.setExternalControl(control)
    manager.noteClientConnected({
      appVersion: '0.1.0',
      protocolVersion: 1,
      platform: 'darwin',
      arch: 'arm64',
    })

    await expect(manager.control({ action: 'start' })).resolves.toMatchObject({
      phase: 'running',
      connected: true,
      managed: true,
      appVersion: '0.1.0',
    })
    expect(spawnProcess).not.toHaveBeenCalled()
    await expect(manager.control({ action: 'stop' })).resolves.toMatchObject({
      phase: 'stopping',
    })
    expect(control).toHaveBeenCalledWith('quit')
  })
})
