import { createHash, randomUUID } from 'node:crypto'
import {
  chmod,
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
} from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

export const DESKTOP_PET_ARTIFACT_SCHEMA_VERSION = 1
export const DESKTOP_PET_MANIFEST = 'activity-pet-manifest.json'

export interface DesktopPetArtifactManifest {
  schemaVersion: 1
  appVersion: string
  protocolVersion: 1
  platform: 'darwin'
  arch: 'arm64' | 'x64'
  executable: string
  sha256: string
  files: Record<string, string>
}

export interface InstalledDesktopPetArtifact {
  appVersion: string
  executablePath: string
  releaseDirectory: string
  rolledBackFrom?: string
}

function safeSegment(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)
}

export function isDesktopPetArtifactManifest(
  value: unknown,
): value is DesktopPetArtifactManifest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const input = value as Record<string, unknown>
  return input.schemaVersion === DESKTOP_PET_ARTIFACT_SCHEMA_VERSION
    && typeof input.appVersion === 'string'
    && safeSegment(input.appVersion)
    && input.protocolVersion === 1
    && input.platform === 'darwin'
    && (input.arch === 'arm64' || input.arch === 'x64')
    && typeof input.executable === 'string'
    && input.executable.length > 0
    && input.executable.length <= 240
    && !isAbsolute(input.executable)
    && !input.executable.split(/[\\/]/).includes('..')
    && typeof input.sha256 === 'string'
    && /^[a-f0-9]{64}$/.test(input.sha256)
    && typeof input.files === 'object'
    && input.files !== null
    && !Array.isArray(input.files)
    && Object.entries(input.files as Record<string, unknown>).length > 0
    && Object.entries(input.files as Record<string, unknown>).every(([path, digest]) => (
      path.length > 0
      && path.length <= 240
      && !isAbsolute(path)
      && !path.split(/[\\/]/).includes('..')
      && typeof digest === 'string'
      && /^[a-f0-9]{64}$/.test(digest)
    ))
}

async function sha256(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

async function filesBelow(root: string, directory = ''): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await filesBelow(root, path))
    else if (entry.isFile()) files.push(path)
    else throw new Error('Desktop Pet artifacts cannot contain symbolic links or special files.')
  }
  return files.sort()
}

async function verifyBundle(root: string, manifest: DesktopPetArtifactManifest): Promise<void> {
  const expectedFiles = Object.keys(manifest.files).sort()
  const actualFiles = await filesBelow(root, 'Activity Pet.app')
  if (JSON.stringify(expectedFiles) !== JSON.stringify(actualFiles)) {
    throw new Error('Desktop Pet bundle contents do not match its manifest.')
  }
  for (const path of expectedFiles) {
    if (await sha256(join(root, path)) !== manifest.files[path]) {
      throw new Error(`Desktop Pet bundle checksum failed for ${path}.`)
    }
  }
}

async function atomicSymlink(target: string, linkPath: string): Promise<void> {
  const temporary = `${linkPath}.${randomUUID()}.tmp`
  await symlink(target, temporary)
  await rename(temporary, linkPath)
}

async function optionalLinkTarget(path: string): Promise<string | undefined> {
  try {
    const stat = await lstat(path)
    if (!stat.isSymbolicLink()) throw new Error(`${path} must be a symbolic link.`)
    return readlink(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

export async function installDesktopPetArtifact(options: {
  artifactRoot: string
  installRoot: string
  platform: NodeJS.Platform
  arch: string
}): Promise<InstalledDesktopPetArtifact> {
  const artifactRoot = await realpath(resolve(options.artifactRoot))
  const raw = JSON.parse(await readFile(join(artifactRoot, DESKTOP_PET_MANIFEST), 'utf8')) as unknown
  if (!isDesktopPetArtifactManifest(raw)) throw new Error('Desktop Pet artifact manifest is invalid.')
  if (raw.platform !== options.platform || raw.arch !== options.arch) {
    throw new Error(`Desktop Pet artifact targets ${raw.platform}-${raw.arch}, not ${options.platform}-${options.arch}.`)
  }
  const sourceExecutable = await realpath(join(artifactRoot, raw.executable))
  if (relative(artifactRoot, sourceExecutable).startsWith('..')) {
    throw new Error('Desktop Pet executable escapes the artifact root.')
  }
  if (await sha256(sourceExecutable) !== raw.sha256) {
    throw new Error('Desktop Pet executable checksum does not match its manifest.')
  }
  await verifyBundle(artifactRoot, raw)

  const installRoot = resolve(options.installRoot)
  const releasesRoot = join(installRoot, 'releases')
  await mkdir(releasesRoot, { recursive: true, mode: 0o700 })
  await chmod(installRoot, 0o700)
  await chmod(releasesRoot, 0o700)

  const releaseName = `${raw.appVersion}-${raw.sha256.slice(0, 12)}`
  const releaseDirectory = join(releasesRoot, releaseName)
  const stagedDirectory = join(installRoot, `.staging-${randomUUID()}`)
  let releaseExists = false
  try {
    const existing = await lstat(releaseDirectory)
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw new Error('Desktop Pet release target is not a real directory.')
    }
    await verifyBundle(releaseDirectory, raw)
    releaseExists = true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (!releaseExists) {
    try {
      await cp(artifactRoot, stagedDirectory, {
        recursive: true,
        errorOnExist: true,
        force: false,
      })
      const stagedExecutable = join(stagedDirectory, raw.executable)
      if (await sha256(stagedExecutable) !== raw.sha256) {
        throw new Error('Desktop Pet checksum changed while staging the artifact.')
      }
      await verifyBundle(stagedDirectory, raw)
      await rename(stagedDirectory, releaseDirectory)
    } finally {
      await rm(stagedDirectory, { recursive: true, force: true })
    }
  }

  const currentLink = join(installRoot, 'current')
  const previousTarget = await optionalLinkTarget(currentLink)
  if (previousTarget !== undefined && previousTarget !== join('releases', releaseName)) {
    await atomicSymlink(previousTarget, join(installRoot, 'previous'))
  }
  await atomicSymlink(join('releases', releaseName), currentLink)
  return {
    appVersion: raw.appVersion,
    executablePath: join(currentLink, raw.executable),
    releaseDirectory,
    ...previousTarget === undefined ? {} : { rolledBackFrom: previousTarget },
  }
}

export async function rollbackDesktopPetArtifact(installRoot: string): Promise<boolean> {
  const root = resolve(installRoot)
  const previous = await optionalLinkTarget(join(root, 'previous'))
  if (previous === undefined) return false
  const current = await optionalLinkTarget(join(root, 'current'))
  await atomicSymlink(previous, join(root, 'current'))
  if (current !== undefined) await atomicSymlink(current, join(root, 'previous'))
  return true
}
