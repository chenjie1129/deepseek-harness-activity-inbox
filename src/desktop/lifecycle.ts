import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import {
  DESKTOP_PET_LIFECYCLE_VERSION,
  type DesktopPetLifecycleCommand,
  type DesktopPetLifecyclePhase,
  type DesktopPetLifecycleSnapshot,
} from '../contracts.js'

type SpawnProcess = (
  executable: string,
  args: readonly string[],
  options: {
    env: NodeJS.ProcessEnv
    stdio: 'ignore'
  },
) => ChildProcess

export interface DesktopPetLifecycleOptions {
  enabled: boolean
  autoStart: boolean
  stopOnHostExit: boolean
  executablePath?: string
  searchRoots: readonly string[]
  environment: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  transitionTimeoutMs?: number
  accessExecutable?: (path: string) => Promise<void>
  spawnProcess?: SpawnProcess
}

function normalizeExecutablePath(path: string): string {
  const resolved = resolve(path)
  return resolved.endsWith('.app')
    ? join(resolved, 'Contents', 'MacOS', 'activity-pet')
    : resolved
}

function executableCandidates(options: DesktopPetLifecycleOptions): string[] {
  const configured = options.executablePath ?? options.environment.DSH_ACTIVITY_PET_EXECUTABLE
  const candidates = configured === undefined ? [] : [normalizeExecutablePath(configured)]
  for (const root of options.searchRoots) {
    candidates.push(join(
      resolve(root),
      'desktop',
      'src-tauri',
      'target',
      'release',
      'bundle',
      'macos',
      'Activity Pet.app',
      'Contents',
      'MacOS',
      'activity-pet',
    ))
  }
  return [...new Set(candidates)]
}

export class DesktopPetLifecycle {
  private readonly options: DesktopPetLifecycleOptions
  private readonly accessExecutable: (path: string) => Promise<void>
  private readonly spawnProcess: SpawnProcess
  private executablePath?: string
  private child: ChildProcess | undefined
  private revision = 0
  private phase: DesktopPetLifecyclePhase
  private message: string | undefined

  constructor(options: DesktopPetLifecycleOptions) {
    this.options = options
    this.accessExecutable = options.accessExecutable ?? (path => access(path, constants.X_OK))
    this.spawnProcess = options.spawnProcess ?? ((executable, args, spawnOptions) => (
      spawn(executable, args, spawnOptions)
    ))
    this.phase = options.enabled
      ? options.platform === undefined || options.platform === 'darwin'
        ? 'unavailable'
        : 'unsupported'
      : 'unsupported'
  }

  snapshot(): DesktopPetLifecycleSnapshot {
    return {
      version: DESKTOP_PET_LIFECYCLE_VERSION,
      revision: this.revision,
      phase: this.phase,
      available: this.executablePath !== undefined,
      managed: this.child !== undefined,
      autoStart: this.options.autoStart,
      ...this.message === undefined ? {} : { message: this.message },
    }
  }

  async initialize(): Promise<DesktopPetLifecycleSnapshot> {
    if (!this.options.enabled || (this.options.platform ?? process.platform) !== 'darwin') {
      this.transition('unsupported')
      return this.snapshot()
    }
    for (const candidate of executableCandidates(this.options)) {
      try {
        await this.accessExecutable(candidate)
        this.executablePath = candidate
        this.transition('stopped')
        if (this.options.autoStart) return this.control({ action: 'start' })
        return this.snapshot()
      } catch {
        // Continue through bounded local candidates.
      }
    }
    this.transition('unavailable', 'Build Activity Pet or configure desktopPetExecutablePath.')
    return this.snapshot()
  }

  async control(command: DesktopPetLifecycleCommand): Promise<DesktopPetLifecycleSnapshot> {
    switch (command.action) {
      case 'start':
        return this.start()
      case 'stop':
        return this.stop()
      case 'restart':
        await this.stop()
        return this.start()
    }
  }

  async dispose(): Promise<void> {
    if (this.options.stopOnHostExit) await this.stop()
  }

  private async start(): Promise<DesktopPetLifecycleSnapshot> {
    if (this.executablePath === undefined) {
      this.transition('unavailable', 'Activity Pet executable is unavailable.')
      return this.snapshot()
    }
    if (this.child !== undefined && this.child.exitCode === null && !this.child.killed) {
      return this.snapshot()
    }

    this.transition('starting')
    try {
      const child = this.spawnProcess(this.executablePath, [], {
        env: this.options.environment,
        stdio: 'ignore',
      })
      this.child = child
      return await new Promise(resolveStart => {
        let settled = false
        const finish = (): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolveStart(this.snapshot())
        }
        const timer = setTimeout(() => {
          if (this.child !== child || this.phase !== 'starting') return
          child.kill('SIGTERM')
          this.transition('error', 'Activity Pet did not report a successful start.')
          finish()
        }, this.options.transitionTimeoutMs ?? 3_000)
        child.once('spawn', () => {
          if (this.child === child) this.transition('running')
          finish()
        })
        child.once('error', error => {
          if (this.child === child) {
            this.child = undefined
            this.transition('error', `Activity Pet failed to start: ${String(error)}`)
          }
          finish()
        })
        child.once('exit', (code, signal) => {
          if (this.child === child) {
            this.child = undefined
            if (this.phase === 'stopping' || code === 0 || signal === 'SIGTERM') {
              this.transition('stopped')
            } else {
              this.transition('error', `Activity Pet exited unexpectedly (${signal ?? code ?? 'unknown'}).`)
            }
          }
          finish()
        })
      })
    } catch (error) {
      this.child = undefined
      this.transition('error', `Activity Pet failed to start: ${String(error)}`)
      return this.snapshot()
    }
  }

  private async stop(): Promise<DesktopPetLifecycleSnapshot> {
    const child = this.child
    if (child === undefined || child.exitCode !== null || child.killed) {
      this.child = undefined
      this.transition('stopped')
      return this.snapshot()
    }
    this.transition('stopping')
    if (!child.kill('SIGTERM')) {
      this.child = undefined
      this.transition('error', 'Activity Pet did not accept the stop request.')
      return this.snapshot()
    }
    return await new Promise(resolveStop => {
      const timer = setTimeout(() => {
        if (this.child === child) {
          child.kill('SIGKILL')
          this.child = undefined
          this.transition('error', 'Activity Pet did not stop before the lifecycle deadline.')
        }
        resolveStop(this.snapshot())
      }, this.options.transitionTimeoutMs ?? 3_000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolveStop(this.snapshot())
      })
    })
  }

  private transition(phase: DesktopPetLifecyclePhase, message?: string): void {
    if (this.phase === phase && this.message === message) return
    this.phase = phase
    this.message = message?.slice(0, 240)
    this.revision += 1
  }
}
