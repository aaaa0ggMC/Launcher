#!/usr/bin/env node
/**
 * 用 Vue 编译器真正编译每个 .vue 的模板。
 * vue-tsc / eslint 都不会报「模板表达式运行时编译失败」这类错误
 * （例如 prettier 无分号配置把 `@click="a = 1; b()"` 拆成两行、去掉分号），
 * 这类问题只会在 dev / build 时才炸。用法：node scripts/check-vue-templates.mjs [文件或目录...]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parse, compileTemplate } from 'vue/compiler-sfc'

const roots = process.argv.slice(2).length ? process.argv.slice(2) : ['src']
const files = []
const walk = (p) => {
  const st = statSync(p)
  if (st.isDirectory()) {
    if (p.endsWith('node_modules')) return
    for (const e of readdirSync(p)) walk(join(p, e))
  } else if (p.endsWith('.vue')) files.push(p)
}
roots.forEach(walk)

let bad = 0
for (const f of files) {
  const { descriptor, errors } = parse(readFileSync(f, 'utf8'), { filename: f })
  const errs = [...errors]
  if (descriptor.template) {
    const r = compileTemplate({
      source: descriptor.template.content,
      filename: f,
      id: 'check',
      compilerOptions: { comments: false }
    })
    errs.push(...r.errors)
  }
  for (const e of errs) {
    bad++
    const loc =
      typeof e === 'object' && e.loc
        ? `:${e.loc.start.line + (descriptor.template?.loc.start.line ?? 1) - 1}`
        : ''
    console.log(`${f}${loc}: ${typeof e === 'string' ? e : e.message}`)
  }
}
console.log(`checked ${files.length} .vue files, ${bad} template error(s)`)
process.exit(bad ? 1 : 0)
