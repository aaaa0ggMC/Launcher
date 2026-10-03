// 无头 / 网页模式构建：复用 electron.vite.config.ts 的插件、alias 与 define。
//   out/headless/index.js —— 纯 Node 宿主（electron 被 alias 成 nop 替身）
//   out/web/              —— 浏览器渲染端（window.cockpit 由 web-shim 提供）
// 运行：node out/headless/index.js
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { build, loadConfigFromFile } from 'vite'

const root = resolve(import.meta.dirname, '..')
const loaded = await loadConfigFromFile(
  { command: 'build', mode: 'production' },
  resolve(root, 'electron.vite.config.ts'),
  root
)
const cfg = loaded.config
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))

// 与 electron-vite 的 externalizeDepsPlugin 同义，但不外置 electron（要被 alias 成替身）
const NOT_EXTERNAL = new Set(['electron', '@electron-toolkit/utils', '@electron-toolkit/preload'])
const external = [
  ...Object.keys(pkg.dependencies ?? {}).filter((d) => !NOT_EXTERNAL.has(d)),
  /^node:/,
  'esbuild'
]
const mainPlugins = (cfg.main.plugins ?? [])
  .flat()
  .filter(
    (p) => p && p.name !== 'vite-plugin-externalize-deps' && !/externalize/.test(p.name ?? '')
  )

await build({
  configFile: false,
  root,
  logLevel: 'info',
  plugins: mainPlugins,
  resolve: {
    alias: { ...cfg.main.resolve.alias, electron: resolve(root, 'src/headless/electron-stub.ts') }
  },
  define: cfg.main.define,
  ssr: { noExternal: true, external: external.filter((e) => typeof e === 'string') },
  build: {
    ssr: resolve(root, 'src/headless/index.ts'),
    outDir: resolve(root, 'out/headless'),
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    rollupOptions: {
      external,
      output: { format: 'cjs', entryFileNames: 'index.js', dynamicImportInCjs: false }
    }
  }
})

const shimPlugin = {
  name: 'cockpit-web-shim',
  transformIndexHtml: {
    order: 'pre',
    handler: (html) =>
      html.replace(
        '<script type="module" src="./main.ts">',
        '<script type="module" src="../../headless/web-shim.ts"></script>\n    <script type="module" src="./main.ts">'
      )
  }
}
await build({
  configFile: false,
  root: resolve(root, 'src/main/ui'),
  base: './',
  plugins: [...(cfg.renderer.plugins ?? []).flat(), shimPlugin],
  resolve: cfg.renderer.resolve,
  define: cfg.renderer.define,
  build: {
    outDir: resolve(root, 'out/web'),
    emptyOutDir: true,
    target: 'esnext',
    rollupOptions: { input: resolve(root, 'src/main/ui/index.html') }
  }
})
