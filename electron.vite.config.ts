import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    },
    build: {
      rollupOptions: {
        // esbuild is a devDependency; load it at runtime from node_modules.
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
