import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'

const platform = process.platform
const arch = process.arch
if (platform !== 'darwin' || (arch !== 'arm64' && arch !== 'x64')) {
  throw new Error(`Desktop artifact packaging is unsupported on ${platform}-${arch}.`)
}

const root = resolve(import.meta.dirname, '..')
const appVersion = JSON.parse(
  await readFile(join(root, 'desktop', 'package.json'), 'utf8'),
).version
const sourceApp = resolve(
  process.argv[2]
    ?? join(root, 'desktop', 'src-tauri', 'target', 'release', 'bundle', 'macos', 'Activity Pet.app'),
)
const output = resolve(
  process.argv[3]
    ?? join(root, 'desktop', 'artifacts', `${platform}-${arch}`),
)
const executable = join('Activity Pet.app', 'Contents', 'MacOS', 'activity-pet')
const sourceExecutable = join(sourceApp, 'Contents', 'MacOS', 'activity-pet')
const sha256 = createHash('sha256').update(await readFile(sourceExecutable)).digest('hex')

async function collectFiles(root, directory = '') {
  const files = {}
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) Object.assign(files, await collectFiles(root, path))
    else if (entry.isFile()) {
      files[join('Activity Pet.app', path)] = createHash('sha256')
        .update(await readFile(join(root, path)))
        .digest('hex')
    } else {
      throw new Error('Desktop artifact cannot contain symbolic links or special files.')
    }
  }
  return files
}

const files = await collectFiles(sourceApp)

await rm(output, { recursive: true, force: true })
await mkdir(output, { recursive: true, mode: 0o700 })
await cp(sourceApp, join(output, 'Activity Pet.app'), { recursive: true })
await writeFile(join(output, 'activity-pet-manifest.json'), `${JSON.stringify({
  schemaVersion: 1,
  appVersion,
  protocolVersion: 1,
  platform,
  arch,
  executable,
  sha256,
  files,
}, null, 2)}\n`, { mode: 0o600 })
await writeFile(join(output, 'package.json'), `${JSON.stringify({
  name: `@chenjie1129/dsh-activity-pet-${platform}-${arch}`,
  version: appVersion,
  private: false,
  os: [platform],
  cpu: [arch],
  files: ['Activity Pet.app', 'activity-pet-manifest.json'],
}, null, 2)}\n`, { mode: 0o600 })

process.stdout.write(`${output}\n`)
