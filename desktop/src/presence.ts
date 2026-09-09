import {
  derivePetProjection,
  isActivityPresenceSnapshot,
  shouldAcceptPresence,
  type ActivityPresenceSnapshot,
  type PetProjection,
  type PresenceCursor,
} from '@chenjie1129/dsh-activity-inbox-plugin/presence'

export type ConnectionPhase =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'offline'

export interface DesktopRuntimeState {
  phase: ConnectionPhase
  attempt: number
  lastError?: string | null
  snapshot?: ActivityPresenceSnapshot | null
}

export interface DesktopPreferences {
  version: 1
  animationsEnabled: boolean
  alwaysOnTop: boolean
  clickThrough: boolean
  detailsOpen: boolean
}

export const DEFAULT_DESKTOP_PREFERENCES: DesktopPreferences = {
  version: 1,
  animationsEnabled: true,
  alwaysOnTop: true,
  clickThrough: false,
  detailsOpen: false,
}

const PREFERENCES_KEY = 'dsh.activity-pet.desktop.v1'

function isConnectionPhase(value: unknown): value is ConnectionPhase {
  return value === 'connecting'
    || value === 'connected'
    || value === 'reconnecting'
    || value === 'offline'
}

export function parseRuntimeState(value: unknown): DesktopRuntimeState | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>
  if (!isConnectionPhase(input.phase)) return undefined
  if (typeof input.attempt !== 'number'
    || !Number.isSafeInteger(input.attempt)
    || input.attempt < 0) return undefined
  if (input.lastError !== undefined
    && input.lastError !== null
    && (typeof input.lastError !== 'string' || input.lastError.length > 240)) return undefined
  if (input.snapshot !== undefined
    && input.snapshot !== null
    && !isActivityPresenceSnapshot(input.snapshot)) return undefined
  return {
    phase: input.phase,
    attempt: input.attempt,
    ...typeof input.lastError === 'string' ? { lastError: input.lastError } : {},
    ...isActivityPresenceSnapshot(input.snapshot) ? { snapshot: input.snapshot } : {},
  }
}

function cursor(snapshot: ActivityPresenceSnapshot | null | undefined): PresenceCursor | undefined {
  return snapshot === undefined || snapshot === null
    ? undefined
    : { instanceId: snapshot.instanceId, revision: snapshot.revision }
}

export function mergeRuntimeState(
  current: DesktopRuntimeState,
  incoming: DesktopRuntimeState,
): DesktopRuntimeState {
  if (incoming.snapshot === undefined || incoming.snapshot === null) return incoming
  if (!shouldAcceptPresence(cursor(current.snapshot), incoming.snapshot)
    && current.snapshot !== undefined
    && current.snapshot !== null) {
    return { ...incoming, snapshot: current.snapshot }
  }
  return incoming
}

export function projectionForRuntime(
  state: DesktopRuntimeState,
  now = Date.now(),
): PetProjection {
  return derivePetProjection(
    state.phase === 'connected' ? state.snapshot ?? undefined : undefined,
    undefined,
    now,
  )
}

export function loadDesktopPreferences(
  storage: Pick<Storage, 'getItem'> | undefined,
): DesktopPreferences {
  if (storage === undefined) return DEFAULT_DESKTOP_PREFERENCES
  try {
    const value = storage.getItem(PREFERENCES_KEY)
    if (value === null) return DEFAULT_DESKTOP_PREFERENCES
    const input = JSON.parse(value) as Record<string, unknown>
    if (input.version !== 1
      || typeof input.animationsEnabled !== 'boolean'
      || typeof input.alwaysOnTop !== 'boolean'
      || typeof input.clickThrough !== 'boolean'
      || typeof input.detailsOpen !== 'boolean') return DEFAULT_DESKTOP_PREFERENCES
    return input as unknown as DesktopPreferences
  } catch {
    return DEFAULT_DESKTOP_PREFERENCES
  }
}

export function saveDesktopPreferences(
  storage: Pick<Storage, 'setItem'> | undefined,
  preferences: DesktopPreferences,
): void {
  try {
    storage?.setItem(PREFERENCES_KEY, JSON.stringify(preferences))
  } catch {
    // Window behavior remains available when persistence is denied.
  }
}
