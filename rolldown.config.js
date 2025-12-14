import { defineConfig } from 'rolldown'
import pkg from './package.json' with { type: 'json' }
import { dts } from 'rolldown-plugin-dts'
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

const external = new RegExp(
  `^(node:|${[...Object.getOwnPropertyNames(pkg.devDependencies ? pkg.devDependencies : []), ...Object.getOwnPropertyNames(pkg.dependencies ? pkg.dependencies : [])].join('|')})`
)

const config = {
  input: './src/index.ts'
}

// 复制assets和config目录
const copyAssetsPlugin = {
  name: 'copy-assets',
  buildEnd() {
    const assetsSourceDir = './assets'
    const assetsTargetDir = './lib/assets'

    const configSourceDir = './manosaba_text_box/config'
    const configTargetDir = './lib/config'

    function copyDir(src, dest) {
      mkdirSync(dest, { recursive: true })
      const entries = readdirSync(src, { withFileTypes: true })

      for (const entry of entries) {
        const srcPath = join(src, entry.name)
        const destPath = join(dest, entry.name)

        if (entry.isDirectory()) {
          copyDir(srcPath, destPath)
        } else {
          mkdirSync(dirname(destPath), { recursive: true })
          copyFileSync(srcPath, destPath)
        }
      }
    }

    try {
      copyDir(assetsSourceDir, assetsTargetDir)
      copyDir(configSourceDir, configTargetDir)
      console.log('✓ Assets (AVIF) and config copied to lib/')
    } catch (err) {
      console.error('✗ Failed to copy assets:', err)
    }
  }
}

export default defineConfig([
  {
    ...config,
    output: [{ file: 'lib/index.mjs', format: 'es', minify: true }],
    external: external,
    plugins: [copyAssetsPlugin]
  },
  {
    ...config,
    output: [{ file: 'lib/index.cjs', format: 'cjs', minify: true }],
    external: external
  },
  {
    ...config,
    output: [{ dir: 'lib', format: 'es' }],
    plugins: [dts({ emitDtsOnly: true })],
    external: external
  }
])
