import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

export const DEFAULT_PRESENCE_KEYCHAIN_SERVICE =
  'com.deepseek-harness.activity-inbox.presence'

const MAX_COMMAND_OUTPUT_BYTES = 8 * 1024
const MIN_TOKEN_LENGTH = 32
const MAX_TOKEN_LENGTH = 256

export interface PresenceCredentialDescriptor {
  service: string
  account: string
}

export interface PresenceCredentialProvider {
  readonly descriptor: PresenceCredentialDescriptor
  getOrCreateToken(): Promise<string>
}

export interface SecurityCommandResult {
  code: number
  stdout: string
  stderr: string
}

export type SecurityCommandRunner = (
  args: readonly string[],
  stdin?: string,
) => Promise<SecurityCommandResult>

export type KeychainCreateRunner = (
  service: string,
  account: string,
  token: string,
) => Promise<SecurityCommandResult>

export interface KeychainCreateCommand {
  executable: '/usr/bin/osascript'
  args: string[]
  stdin: string
}

const KEYCHAIN_CREATE_SCRIPT = `
ObjC.import('Foundation')
ObjC.import('Security')
function run(argv) {
  const data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile
  const query = $.NSMutableDictionary.alloc.init
  query.setObjectForKey($('genp'), $('class'))
  query.setObjectForKey($(argv[0]), $('svce'))
  query.setObjectForKey($(argv[1]), $('acct'))
  query.setObjectForKey(data, $('v_Data'))
  const status = Number($.SecItemAdd(query, null))
  if (status !== 0) throw new Error('SecItemAdd failed with status ' + status)
  return 'created'
}
`.trim()

function appendBounded(current: string, chunk: Buffer): string {
  if (Buffer.byteLength(current) >= MAX_COMMAND_OUTPUT_BYTES) return current
  return `${current}${chunk.toString('utf8')}`.slice(0, MAX_COMMAND_OUTPUT_BYTES)
}

function runCommand(
  executable: string,
  args: readonly string[],
  stdin?: string,
): Promise<SecurityCommandResult> {
  return (
  new Promise((resolveCommand, reject) => {
    const child = spawn(executable, [...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => {
      stdout = appendBounded(stdout, chunk as Buffer)
    })
    child.stderr.on('data', chunk => {
      stderr = appendBounded(stderr, chunk as Buffer)
    })
    child.once('error', reject)
    child.once('close', code => {
      resolveCommand({ code: code ?? 1, stdout, stderr })
    })
    child.stdin.on('error', () => {})
    if (stdin === undefined) child.stdin.end()
    else child.stdin.end(stdin)
  })
  )
}

export const runSecurityCommand: SecurityCommandRunner = (args, stdin) => (
  runCommand('/usr/bin/security', args, stdin)
)

export function keychainCreateCommand(
  service: string,
  account: string,
  token: string,
): KeychainCreateCommand {
  return {
    executable: '/usr/bin/osascript',
    args: [
      '-l', 'JavaScript',
      '-e', KEYCHAIN_CREATE_SCRIPT,
      '--', service, account,
    ],
    stdin: token,
  }
}

export const runKeychainCreate: KeychainCreateRunner = (
  service,
  account,
  token,
) => {
  const command = keychainCreateCommand(service, account, token)
  return runCommand(command.executable, command.args, command.stdin)
}

function validateToken(token: string): string {
  if (token.length < MIN_TOKEN_LENGTH || token.length > MAX_TOKEN_LENGTH) {
    throw new Error('Presence Keychain item contains an invalid token.')
  }
  return token
}

function commandFailure(action: string, result: SecurityCommandResult): Error {
  return new Error(
    `Unable to ${action} Presence credential in macOS Keychain`
    + ` (security exited ${result.code}).`,
  )
}

export function keychainAccountForSocket(socketPath: string): string {
  const digest = createHash('sha256').update(resolve(socketPath)).digest('hex')
  return `socket-${digest.slice(0, 32)}`
}

export interface MacOSKeychainCredentialOptions {
  socketPath: string
  service?: string
  account?: string
  platform?: NodeJS.Platform
  run?: SecurityCommandRunner
  create?: KeychainCreateRunner
}

function validateKeychainField(name: string, value: string): string {
  if (value.length < 1 || value.length > 256 || value.includes('\0') || value.includes('\n')) {
    throw new Error(`Presence Keychain ${name} must be a single line of 1 to 256 characters.`)
  }
  return value
}

export class MacOSKeychainCredentialProvider implements PresenceCredentialProvider {
  readonly descriptor: PresenceCredentialDescriptor
  private readonly platform: NodeJS.Platform
  private readonly run: SecurityCommandRunner
  private readonly create: KeychainCreateRunner

  constructor(options: MacOSKeychainCredentialOptions) {
    this.descriptor = {
      service: validateKeychainField(
        'service',
        options.service ?? DEFAULT_PRESENCE_KEYCHAIN_SERVICE,
      ),
      account: validateKeychainField(
        'account',
        options.account ?? keychainAccountForSocket(options.socketPath),
      ),
    }
    this.platform = options.platform ?? process.platform
    this.run = options.run ?? runSecurityCommand
    this.create = options.create ?? runKeychainCreate
  }

  private async readToken(): Promise<SecurityCommandResult> {
    const { service, account } = this.descriptor
    return this.run([
      'find-generic-password',
      '-a', account,
      '-s', service,
      '-w',
    ])
  }

  async getOrCreateToken(): Promise<string> {
    if (this.platform !== 'darwin') {
      throw new Error('Presence Keychain integration requires macOS.')
    }

    const existing = await this.readToken()
    if (existing.code === 0) return validateToken(existing.stdout.trim())
    if (existing.code !== 44) throw commandFailure('read', existing)

    const token = randomBytes(32).toString('base64url')
    const { service, account } = this.descriptor
    const created = await this.create(service, account, token)
    if (created.code === 0) {
      const verified = await this.readToken()
      if (verified.code === 0 && validateToken(verified.stdout.trim()) === token) {
        return token
      }
      throw new Error('Presence credential failed Keychain read-after-write verification.')
    }

    // Another Host may have won the create race. Re-read instead of replacing
    // its credential, which would disconnect the already-running instance.
    const raced = await this.readToken()
    if (raced.code === 0) return validateToken(raced.stdout.trim())
    throw commandFailure('create', created)
  }
}
