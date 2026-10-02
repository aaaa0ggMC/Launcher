import { createRequire } from 'module'
import { existsSync, readdirSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'

// campusnet 依赖的 hustnet 只装在 ability 的 node_modules 里；tsconfig 又把
// `hustnet` 指到本地 .d.ts 做 typecheck。主进程打包必须显式 alias 回真包，
// 否则 Vite 会跟着 tsconfig paths 去解析 .d.ts，运行时没有实现。
const require = createRequire(import.meta.url)
let hustnetEntry: string | undefined
try {
  hustnetEntry = require.resolve('hustnet', {
    paths: [resolve('src/abilities/campusnet')]
  })
} catch {
  hustnetEntry = undefined
}

// campusinfo 依赖的 hustpass 同理（真包是源码，typecheck 走本地声明，运行时 alias 回真包）。
// 其验证码识别（stdchar）是独立子进程：打包后 import.meta.url 失效，因此在构建期解析出
// stdchar CLI 与 tsx 可执行文件的绝对路径，通过 define 注入给 campusinfo/service.ts。
const abilityRequire = createRequire(resolve('src/abilities/campusinfo/package.json'))
let hustpassEntry: string | undefined
let stdcharCli = ''
let tsxBin = ''
try {
  hustpassEntry = abilityRequire.resolve('hustpass')
  stdcharCli = resolve(hustpassEntry, '..', 'stdchar', 'cli.ts')
  tsxBin = resolve('src/abilities/campusinfo/node_modules/.bin/tsx')
} catch {
  hustpassEntry = undefined
}

// ── src/abilities/toggle.json：构建期的能力开关 ─────────────────────────────
// 形如 { "campusinfo": false, "fnaf": false }；缺省 = 启用，`"*": false` 把默认改成关闭
// （再用 `"id": true` 逐个点名，即白名单）。被关掉的能力文件夹**不进入任何
// `import.meta.glob('…/abilities/*/…')`**，等于这个文件夹不存在：它里面写到一半的代码、
// 缺失的依赖都不会影响构建与启动。改完需要重启 dev / 重新构建。
// `settings` 是外壳必需的，不允许关。个人文件，已 gitignore（见 AGENTS.md「toggle.json」）。
const ABILITIES_DIR = resolve('src/abilities')
function disabledAbilityIds(): string[] {
  const file = resolve(ABILITIES_DIR, 'toggle.json')
  if (!existsSync(file)) return []
  let toggle: Record<string, unknown>
  try {
    toggle = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch (e) {
    console.warn(`[toggle.json] 解析失败，按全部启用处理: ${(e as Error).message}`)
    return []
  }
  const dflt = toggle['*'] !== false
  return readdirSync(ABILITIES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== 'settings')
    .map((d) => d.name)
    .filter((id) => (typeof toggle[id] === 'boolean' ? toggle[id] === false : !dflt))
}
const DISABLED_ABILITIES = disabledAbilityIds()
if (DISABLED_ABILITIES.length)
  console.log(`[toggle.json] 本次构建排除能力: ${DISABLED_ABILITIES.join(', ')}`)

/** 给每个指向 abilities/*\/ 的 import.meta.glob 追加 `!…/abilities/<id>/**` 排除模式。 */
function abilityToggleGlobPlugin(): Plugin {
  const re =
    /(import\.meta\.glob(?:<[^(]*?>)?\(\s*)(['"])((?:(?!\2)[^\n])*?)abilities\/\*\/((?:(?!\2)[^\n])*)\2/g
  return {
    name: 'cockpit-ability-toggle',
    enforce: 'pre',
    transform(code, id) {
      if (!DISABLED_ABILITIES.length || !code.includes('import.meta.glob')) return null
      if (!/\.(ts|vue)(\?|$)/.test(id)) return null
      let hit = false
      const out = code.replace(re, (_m, head: string, q: string, prefix: string, rest: string) => {
        hit = true
        const neg = DISABLED_ABILITIES.map((a) => `${q}!${prefix}abilities/${a}/**${q}`).join(', ')
        return `${head}[${q}${prefix}abilities/*/${rest}${q}, ${neg}]`
      })
      return hit ? { code: out, map: null } : null
    }
  }
}
const toggleDefine = { __DISABLED_ABILITIES__: JSON.stringify(DISABLED_ABILITIES) }

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin(),
      abilityToggleGlobPlugin(),
      {
        // hustpass 的依赖 sm-crypto 是 CJS，内联后会经 rollup 的 commonjsRequire 桩函数
        // 动态引用 Node 内置模块（如 crypto），桩函数直接 throw，应用一加载就崩。
        // 主进程输出本身就是 CJS，把桩函数换成真 require 即可。
        name: 'cockpit-commonjs-require-shim',
        renderChunk(code) {
          const stub = /function commonjsRequire\(path\w*\) \{\s*throw new Error\([^\n]*\);\s*\}/
          return stub.test(code)
            ? {
                code: code.replace(stub, 'function commonjsRequire(id) { return require(id); }'),
                map: null
              }
            : null
        }
      }
    ],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        ...(hustnetEntry ? { hustnet: hustnetEntry } : {}),
        ...(hustpassEntry ? { hustpass: hustpassEntry } : {})
      }
    },
    define: {
      ...toggleDefine,
      __STDCHAR_CLI__: JSON.stringify(stdcharCli),
      __TSX_BIN__: JSON.stringify(tsxBin)
    },
    build: {
      rollupOptions: {
        // esbuild stays a root dependency; load it at runtime from node_modules.
        external: ['esbuild'],
        output: {
          // keep native import() for ability-loader (.mjs external modules)
          dynamicImportInCjs: false
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    // UI framework lives in src/main/ui (part of the "main" program shell).
    root: resolve('src/main/ui'),
    resolve: {
      alias: {
        '@ui': resolve('src/main/ui'),
        '@abilities': resolve('src/abilities'),
        '@background': resolve('src/background'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [abilityToggleGlobPlugin(), vue()],
    define: toggleDefine,
    build: {
      rollupOptions: {
        input: resolve('src/main/ui/index.html')
      }
    }
  }
})
