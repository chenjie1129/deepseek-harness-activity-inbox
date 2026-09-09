import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_PRESENCE_KEYCHAIN_SERVICE,
  keychainCreateCommand,
  keychainAccountForSocket,
  MacOSKeychainCredentialProvider,
  type KeychainCreateRunner,
  type SecurityCommandRunner,
} from '../src/presence/keychain.js'

describe('macOS Presence Keychain provider', () => {
  it('reads an existing token without placing it in command arguments', async () => {
    const token = 'a'.repeat(43)
    const run: SecurityCommandRunner = vi.fn(async () => ({
      code: 0,
      stdout: `${token}\n`,
      stderr: '',
    }))
    const provider = new MacOSKeychainCredentialProvider({
      socketPath: '/tmp/presence.sock',
      platform: 'darwin',
      run,
    })

    await expect(provider.getOrCreateToken()).resolves.toBe(token)
    expect(run).toHaveBeenCalledWith([
      'find-generic-password',
      '-a', keychainAccountForSocket('/tmp/presence.sock'),
      '-s', DEFAULT_PRESENCE_KEYCHAIN_SERVICE,
      '-w',
    ])
    expect(JSON.stringify(vi.mocked(run).mock.calls)).not.toContain(token)
  })

  it('creates a random token through stdin and does not expose it in argv', async () => {
    let stored = ''
    let reads = 0
    const run: SecurityCommandRunner = async () => {
      reads += 1
      return reads === 1
        ? { code: 44, stdout: '', stderr: 'not found' }
        : { code: 0, stdout: `${stored}\n`, stderr: '' }
    }
    const create: KeychainCreateRunner = vi.fn(async (_service, _account, token) => {
      stored = token
      return { code: 0, stdout: 'created\n', stderr: '' }
    })
    const provider = new MacOSKeychainCredentialProvider({
      socketPath: '/tmp/create.sock',
      platform: 'darwin',
      run,
      create,
    })

    const token = await provider.getOrCreateToken()
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(create).toHaveBeenCalledWith(
      DEFAULT_PRESENCE_KEYCHAIN_SERVICE,
      keychainAccountForSocket('/tmp/create.sock'),
      token,
    )
    const command = keychainCreateCommand('service', 'account', token)
    expect(command.stdin).toBe(token)
    expect(command.args).not.toContain(token)
  })

  it('uses the winner of a concurrent create race instead of overwriting it', async () => {
    const winner = 'w'.repeat(43)
    const run: SecurityCommandRunner = vi.fn(async () => {
      if (vi.mocked(run).mock.calls.length === 1) {
        return { code: 44, stdout: '', stderr: 'not found' }
      }
      return { code: 0, stdout: `${winner}\n`, stderr: '' }
    })
    const create: KeychainCreateRunner = vi.fn(async () => ({
      code: 45,
      stdout: '',
      stderr: 'duplicate',
    }))
    const provider = new MacOSKeychainCredentialProvider({
      socketPath: '/tmp/race.sock',
      platform: 'darwin',
      run,
      create,
    })

    await expect(provider.getOrCreateToken()).resolves.toBe(winner)
    expect(run).toHaveBeenCalledTimes(2)
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('does not copy credential command output into errors', async () => {
    let call = 0
    let token = ''
    const run: SecurityCommandRunner = async () => {
      call += 1
      if (call === 1) return { code: 44, stdout: '', stderr: 'not found' }
      return { code: 1, stdout: '', stderr: `failed for ${token}` }
    }
    const create: KeychainCreateRunner = async (_service, _account, value) => {
      token = value
      return { code: 1, stdout: '', stderr: `failed for ${token}` }
    }
    const provider = new MacOSKeychainCredentialProvider({
      socketPath: '/tmp/failure.sock',
      platform: 'darwin',
      run,
      create,
    })

    let error: unknown
    try {
      await provider.getOrCreateToken()
    } catch (value) {
      error = value
    }
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).not.toContain(token)
  })

  it('rejects unsupported platforms and malformed stored credentials', async () => {
    const neverRun = vi.fn()
    const unsupported = new MacOSKeychainCredentialProvider({
      socketPath: '/tmp/linux.sock',
      platform: 'linux',
      run: neverRun,
    })
    await expect(unsupported.getOrCreateToken()).rejects.toThrow('requires macOS')
    expect(neverRun).not.toHaveBeenCalled()

    const malformed = new MacOSKeychainCredentialProvider({
      socketPath: '/tmp/malformed.sock',
      platform: 'darwin',
      run: async () => ({ code: 0, stdout: 'short\n', stderr: '' }),
    })
    await expect(malformed.getOrCreateToken()).rejects.toThrow('invalid token')
  })
})
