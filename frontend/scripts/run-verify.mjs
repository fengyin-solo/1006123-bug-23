// 一键核验：用平台对应的 esbuild 原生二进制把数据层/服务层打成 ESM，再跑端到端断言。
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outdir = resolve(root, 'scripts/dist-verify')

const entry = resolve(root, 'scripts/verify-entry.ts')
const common = {
  bundle: true,
  format: 'esm',
  platform: 'node',
  alias: { '@': resolve(root, 'src') },
}
await build({ ...common, entryPoints: [entry], outfile: resolve(outdir, 'bundle.mjs') })
await build({ ...common, entryPoints: [entry], outfile: resolve(outdir, 'bundle-reload.mjs') })
await build({ ...common, entryPoints: [entry], outfile: resolve(outdir, 'bundle-reload2.mjs') })

const result = spawnSync(process.execPath, [resolve(root, 'scripts/verify.mjs')], { stdio: 'inherit' })
process.exit(result.status ?? 1)
