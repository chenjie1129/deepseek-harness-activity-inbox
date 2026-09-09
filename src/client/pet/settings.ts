/** Browser-local presentation settings. No task or session data is stored. */

export interface PetSettings {
  version: 1
  enabled: boolean
  animationsEnabled: boolean
}

export interface KeyValueStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export const PET_SETTINGS_KEY = 'dsh.activity-inbox.pet.v1'
export const DEFAULT_PET_SETTINGS: PetSettings = Object.freeze({
  version: 1,
  enabled: true,
  animationsEnabled: true,
})

export function readPetSettings(storage: KeyValueStorage | undefined): PetSettings {
  if (storage === undefined) return { ...DEFAULT_PET_SETTINGS }
  try {
    const raw = storage.getItem(PET_SETTINGS_KEY)
    if (raw === null) return { ...DEFAULT_PET_SETTINGS }
    const value = JSON.parse(raw) as unknown
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ...DEFAULT_PET_SETTINGS }
    const input = value as Record<string, unknown>
    if (input.version !== 1 || typeof input.enabled !== 'boolean' || typeof input.animationsEnabled !== 'boolean') {
      return { ...DEFAULT_PET_SETTINGS }
    }
    return {
      version: 1,
      enabled: input.enabled,
      animationsEnabled: input.animationsEnabled,
    }
  } catch {
    return { ...DEFAULT_PET_SETTINGS }
  }
}

export function writePetSettings(storage: KeyValueStorage | undefined, settings: PetSettings): boolean {
  if (storage === undefined) return false
  try {
    storage.setItem(PET_SETTINGS_KEY, JSON.stringify(settings))
    return true
  } catch {
    return false
  }
}
