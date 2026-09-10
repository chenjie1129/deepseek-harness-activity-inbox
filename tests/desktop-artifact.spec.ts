import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readlink, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  installDesktopPetArtifact,
  rollbackDesktopPetArtifact,
} from '../src/desktop/artifact.js'

const roots: string[] = []

async function artifact(version: string, content: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'activity-pet-artifact-'))
  roots.push(root)
  const executable = join('Activity Pet.app', 'Contents', 'MacOS', 'activity-pet')
  const digest = createHash('sha256').update(content).digest('hex')
  await mkdir(join(root, 'Activity Pet.app', 'Contents', 'MacOS'), { recursive: true })
  await writeFile(join(root, executable), content, { mode: 0o700 })
  await writeFile(join(root, 'activity-pet-manifest.json'), JSON.stringify({
    schemaVersion: 1,
    appVersion: version,
    protocolVersion: 1,
    platform: 'darwin',
    arch: 'arm64',
    executable,
    sha256: digest,
    files: { [executable]: digest },
  }))
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('Desktop Pet platform artifacts', () => {
  it('verifies, stages, atomically activates, and rolls back releases', async () => {
    const installRoot = await mkdtemp(join(tmpdir(), 'activity-pet-install-'))
    roots.push(installRoot)
    const first = await artifact('0.1.0', 'first')
    const second = await artifact('0.2.0', 'second')

    const installedFirst = await installDesktopPetArtifact({
      artifactRoot: first,
      installRoot,
      platform: 'darwin',
      arch: 'arm64',
    })
    expect(installedFirst.executablePath).toContain('/current/')
    await expect(installDesktopPetArtifact({
      artifactRoot: first,
      installRoot,
      platform: 'darwin',
      arch: 'arm64',
    })).resolves.toMatchObject({
      appVersion: '0.1.0',
      releaseDirectory: installedFirst.releaseDirectory,
    })
    const installedSecond = await installDesktopPetArtifact({
      artifactRoot: second,
      installRoot,
      platform: 'darwin',
      arch: 'arm64',
    })
    expect(installedSecond.rolledBackFrom).toContain('0.1.0-')
    expect(await readlink(join(installRoot, 'current'))).toContain('0.2.0-')

    await expect(rollbackDesktopPetArtifact(installRoot)).resolves.toBe(true)
    expect(await readlink(join(installRoot, 'current'))).toContain('0.1.0-')
  })

  it('rejects a tampered executable before changing the active release', async () => {
    const installRoot = await mkdtemp(join(tmpdir(), 'activity-pet-install-'))
    roots.push(installRoot)
    const source = await artifact('0.1.0', 'trusted')
    await writeFile(
      join(source, 'Activity Pet.app', 'Contents', 'MacOS', 'activity-pet'),
      'tampered',
    )

    await expect(installDesktopPetArtifact({
      artifactRoot: source,
      installRoot,
      platform: 'darwin',
      arch: 'arm64',
    })).rejects.toThrow('checksum')
    await expect(readlink(join(installRoot, 'current'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
