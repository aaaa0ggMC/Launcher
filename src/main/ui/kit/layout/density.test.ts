import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveDensity, type KitDensity } from './density'

/**
 * 密度上下文契约（用户第三次提「combobox 根本没改过」后立的规矩）：
 * inline 档做了却没人用，是因为密度要靠调用方记得传 size——demo 和迁移过的分区一忘就废。
 * 现在由容器提供：KitSettingRow provide 'inline'，控件层未显式传 size 时读它。
 * 这条契约测试盯的就是「忘了传也不能退化成 input」。
 */

test('密度解析：显式 size 优先（逃生门）', () => {
  assert.equal(resolveDensity('input', 'inline'), 'input', '显式传 input 时不被上下文覆盖')
  assert.equal(resolveDensity('inline', 'input'), 'inline', '显式传 inline 时在外面也是 inline')
})

test('密度解析：未显式传时吃容器上下文', () => {
  assert.equal(
    resolveDensity(undefined, 'inline'),
    'inline',
    '在设置行里 = inline（不用调用方记参数）'
  )
  assert.equal(resolveDensity(undefined, 'input'), 'input')
})

test('密度解析：没有上下文时回落 input', () => {
  assert.equal(resolveDensity(undefined, undefined), 'input', '在外面渲染 = input 档（44px）')
})

test('密度取值只有两档（拼写错了也该被发现）', () => {
  const all: KitDensity[] = ['input', 'inline']
  assert.deepEqual(all.slice().sort(), ['inline', 'input'])
})
