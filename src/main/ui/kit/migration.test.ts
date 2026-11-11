import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

/**
 * 迁移纪律的机械化检查（ThemeSection 事故的直接防线）。
 *
 * 事故回放：ThemeSection 迁移时 <style scoped> 整块被删，theme-grid / theme-card /
 * theme-preview / theme-dot 五个类只剩使用没有定义 → 主题卡片高度塌成一条虚线。
 * 而 typecheck / lint / test 全绿——只有「用了但没定义」这一种信号。
 *
 * 纪律：迁移 ability 页面时禁止删除原文件的 <style scoped>；要改观感就追加覆盖，
 * 类定义不许消失。这里拿迁移前的 commit 做基线（git show）机械化地守这条。
 */

/** 迁过的文件 → 迁移前的 commit（基线）。新增迁移时往这里加一行。 */
const MIGRATED: Record<string, string> = {
  'src/abilities/settings/items/ThemeSection.vue': 'f321908~1',
  'src/abilities/settings/items/FontSection.vue': 'f321908~1',
  'src/abilities/settings/items/AnimationSection.vue': 'f321908~1',
  'src/abilities/settings/items/WindowSection.vue': 'f321908~1',
  'src/abilities/settings/items/ZoomSection.vue': 'f321908~1',
  'src/abilities/settings/items/BootServicesSection.vue': 'f321908~1',
  'src/abilities/mirror/View.vue': 'ea8c0ce~1'
}

const GLOBAL_CSS = ['src/main/ui/kit/kit.css', 'src/main/ui/styles/global.css']
  .map((p) => {
    try {
      return readFileSync(p, 'utf8')
    } catch {
      return ''
    }
  })
  .join('\n')

const CLASS_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/

function styleClasses(source: string): Set<string> {
  const found = new Set<string>()
  for (const m of source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) {
    for (const sel of m[1].matchAll(/(?:^|[},])\s*([^{}]+?)\s*\{/g)) {
      for (const cls of sel[1].matchAll(/\.([A-Za-z0-9_-]+)/g)) found.add(cls[1])
    }
  }
  return found
}

function cssClasses(css: string): Set<string> {
  const found = new Set<string>()
  for (const m of css.matchAll(/\.([A-Za-z0-9_-]+)/g)) found.add(m[1])
  return found
}

/** 模板里静态用到的类（class="…" + :class 里的字符串字面量） */
function usedClasses(source: string): Set<string> {
  const used = new Set<string>()
  const start = source.indexOf('<template>')
  const end = source.indexOf('</template>')
  if (start < 0 || end < 0) return used
  const tpl = source.slice(start, end)
  for (const m of tpl.matchAll(/class="([^"]*)"/g)) {
    for (const c of m[1].split(/\s+/)) if (c && CLASS_NAME.test(c)) used.add(c)
  }
  for (const m of tpl.matchAll(/:class="([^"]*)"/g)) {
    for (const q of m[1].matchAll(/'([^']*)'|"([^"]*)"/g)) {
      for (const part of (q[1] ?? q[2]).split(/\s+/)) {
        if (part && CLASS_NAME.test(part)) used.add(part)
      }
    }
  }
  return used
}

function show(rev: string, path: string): string {
  return execFileSync('git', ['show', `${rev}:${path}`], { encoding: 'utf8' })
}

test('迁移纪律：迁移前定义的类，迁移后不能只剩使用没有定义', () => {
  const problems: string[] = []
  for (const [path, base] of Object.entries(MIGRATED)) {
    let before: string
    try {
      before = show(base, path)
    } catch {
      continue
    }
    const after = readFileSync(path, 'utf8')
    const beforeClasses = styleClasses(before)
    const afterClasses = new Set([...styleClasses(after), ...cssClasses(GLOBAL_CSS)])
    const used = usedClasses(after)
    const lost = [...beforeClasses].filter((c) => used.has(c) && !afterClasses.has(c))
    if (lost.length) {
      problems.push(`${path}: 这些类迁移后没有定义了 → ${lost.map((c) => `.${c}`).join(' ')}`)
    }
  }
  assert.deepEqual(
    problems,
    [],
    `迁移把 style 块弄丢了（纪律：禁止删除 <style scoped>）：\n${problems.join('\n')}`
  )
})

test('迁移纪律：迁移前有 style 块的文件，迁移后必须还有', () => {
  const problems: string[] = []
  for (const [path, base] of Object.entries(MIGRATED)) {
    let before: string
    try {
      before = show(base, path)
    } catch {
      continue
    }
    if (/<style/.test(before) && !/<style/.test(readFileSync(path, 'utf8'))) {
      problems.push(`${path}: 迁移前有 style 块，迁移后没有了`)
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'))
})
