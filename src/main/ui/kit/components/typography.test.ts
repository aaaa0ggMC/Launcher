import assert from 'node:assert/strict'
import { test } from 'node:test'

/** KitImport 的文案拼装（组件是纯展示，这里钉住格式，避免改写坏 gallery） */
function importLine(from: string, names?: string[]): string {
  return names?.length ? `import { ${names.join(', ')} } from '${from}'` : `import '${from}'`
}

test('KitImport：带名字时拼成 import 花括号形式，否则退化成整模块导入', () => {
  assert.equal(
    importLine('@ui/kit', ['KitPage', 'KitSmartRow']),
    "import { KitPage, KitSmartRow } from '@ui/kit'"
  )
  assert.equal(importLine('@ui/kit'), "import '@ui/kit'")
  assert.equal(importLine('@ui/kit', []), "import '@ui/kit'")
})
