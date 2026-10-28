// Copy non-TS assets (preferences HTML + the menubar icon) into dist/ after tsc.
import { mkdirSync, copyFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

const srcUi = join(root, 'src', 'ui')
const outUi = join(root, 'dist', 'ui')
mkdirSync(outUi, { recursive: true })
for (const f of readdirSync(srcUi)) {
  if (f.endsWith('.html')) copyFileSync(join(srcUi, f), join(outUi, f))
}

const srcAssets = join(root, 'assets')
const outAssets = join(root, 'dist', 'assets')
mkdirSync(outAssets, { recursive: true })
for (const f of readdirSync(srcAssets)) {
  if (/\.(png|ico|svg)$/.test(f)) copyFileSync(join(srcAssets, f), join(outAssets, f))
}

console.log('assets copied -> dist/ui + dist/assets')
