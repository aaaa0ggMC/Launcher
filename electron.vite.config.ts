import { createRequire } from 'module'
import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
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

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        ...(hustnetEntry ? { hustnet: hustnetEntry } : {}),
        ...(hustpassEntry ? { hustpass: hustpassEntry } : {})
      }
    },
    define: {
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
    plugins: [vue()],
    build: {
      rollupOptions: {
        input: resolve('src/main/ui/index.html')
      }
    }
  }
})
