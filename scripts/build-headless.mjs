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

// ── 分发包：out/pack（headless + web + 只含运行时外置依赖的 package.json）──────────────
// 手机 / Termux 上不需要装 electron、vite 等整套工具链：桌面机构建后把 tar 拷过去，
//   tar xzf cockpit-headless.tgz && cd cockpit-headless && npm install --omit=dev && node headless/index.js
if (process.argv.includes('--pack')) {
  const { cpSync, mkdirSync, rmSync, writeFileSync } = await import('node:fs')
  const { execFileSync } = await import('node:child_process')
  const bundled = readFileSync(resolve(root, 'out/headless/index.js'), 'utf8')
  const used = Object.keys(pkg.dependencies ?? {}).filter(
    (d) => !NOT_EXTERNAL.has(d) && bundled.includes(`require("${d}`)
  )
  // 原生 / 平台相关的做成可选依赖：装不上也不影响启动（对应能力自行降级）
  const OPTIONAL = new Set(['esbuild', 'dbus-next'])
  const dest = resolve(root, 'out/pack/cockpit-headless')
  rmSync(resolve(root, 'out/pack'), { recursive: true, force: true })
  mkdirSync(dest, { recursive: true })
  cpSync(resolve(root, 'out/headless'), resolve(dest, 'headless'), { recursive: true })
  cpSync(resolve(root, 'out/web'), resolve(dest, 'web'), { recursive: true })
  writeFileSync(
    resolve(dest, 'package.json'),
    JSON.stringify(
      {
        name: 'cockpit-headless',
        version: pkg.version,
        private: true,
        description: 'Linux Cockpit headless host + web client (no Electron)',
        scripts: { start: 'node headless/index.js' },
        dependencies: Object.fromEntries(
          used.filter((d) => !OPTIONAL.has(d)).map((d) => [d, pkg.dependencies[d]])
        ),
        optionalDependencies: Object.fromEntries(
          used.filter((d) => OPTIONAL.has(d)).map((d) => [d, pkg.dependencies[d]])
        )
      },
      null,
      2
    ) + '\n'
  )
  execFileSync('tar', [
    'czf',
    resolve(root, 'out/cockpit-headless.tgz'),
    '-C',
    resolve(root, 'out/pack'),
    'cockpit-headless'
  ])
  console.log('packed → out/cockpit-headless.tgz  deps:', used.join(', '))
}
