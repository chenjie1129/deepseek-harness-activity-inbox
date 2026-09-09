import { rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { build } from 'esbuild'

const external = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-client-connection/client',
  '@deepseek-ai/dsh-client-runtime',
  '@deepseek-ai/dsh-client-runtime/client',
  '@deepseek-ai/dsh-client-ui-sidebar',
  '@deepseek-ai/dsh-client-ui-sidebar/client',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-session-persistence',
  '@deepseek-ai/dsh-user-approval',
  '@deepseek-ai/schemastery',
  'react',
  'react/jsx-runtime',
]

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)))
  })
}

await rm('lib', { recursive: true, force: true })

await build({
  entryPoints: { index: 'src/index.ts' },
  outdir: 'lib',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  external,
})

await build({
  entryPoints: ['src/presence/index.ts'],
  outfile: 'lib/presence.js',
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: ['es2022'],
  sourcemap: true,
})

await build({
  entryPoints: ['src/presence/host.ts'],
  outfile: 'lib/presence-host.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node22'],
  sourcemap: true,
})

await build({
  entryPoints: ['src/client/index.tsx'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['es2022'],
  sourcemap: true,
  external,
  loader: { '.css': 'text' },
  banner: { js: 'window.__ModuleLoader__.load({id:"@chenjie1129/dsh-activity-inbox-plugin",factory:(require)=>{var module={exports:{}};var exports=module.exports;' },
  footer: { js: 'return module.exports;}});' },
})

await run(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'])
