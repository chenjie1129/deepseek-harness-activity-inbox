import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PET_SETTINGS,
  PET_SETTINGS_KEY,
  readPetSettings,
  writePetSettings,
  type KeyValueStorage,
} from '../src/client/pet/settings.js'

function memoryStorage(initial?: string): KeyValueStorage & { value: string | null } {
  return {
    value: initial ?? null,
    getItem() {
      return this.value
    },
    setItem(_key, value) {
      this.value = value
    },
  }
}

describe('Pet settings', () => {
  it('falls back safely for missing, malformed, or inaccessible storage', () => {
    expect(readPetSettings(undefined)).toEqual(DEFAULT_PET_SETTINGS)
    expect(readPetSettings(memoryStorage('{bad json'))).toEqual(DEFAULT_PET_SETTINGS)
    expect(readPetSettings(memoryStorage('{"version":1,"enabled":"yes"}'))).toEqual(DEFAULT_PET_SETTINGS)
    expect(readPetSettings({
      getItem() { throw new Error('denied') },
      setItem() {},
    })).toEqual(DEFAULT_PET_SETTINGS)
  })

  it('round-trips valid presentation-only settings', () => {
    const storage = memoryStorage()
    const settings = { version: 1 as const, enabled: false, animationsEnabled: false }
    expect(writePetSettings(storage, settings)).toBe(true)
    expect(storage.value).toBe(JSON.stringify(settings))
    expect(readPetSettings(storage)).toEqual(settings)
  })

  it('reports a failed browser storage write without throwing', () => {
    const storage: KeyValueStorage = {
      getItem: () => null,
      setItem(key) {
        expect(key).toBe(PET_SETTINGS_KEY)
        throw new Error('quota')
      },
    }
    expect(writePetSettings(storage, DEFAULT_PET_SETTINGS)).toBe(false)
  })
})
