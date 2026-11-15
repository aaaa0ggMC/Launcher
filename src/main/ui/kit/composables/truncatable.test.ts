import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isTruncatedProbe, type TruncateProbe } from './useTruncatable'

/**
 * 截断判定纯函数（SPEC「信息降级链」档 1 的判定内核）。
 * 用户 live 数据把两条路都钉出来了：
 *   ① 自己盒子在裁——「界面缩放 / 可整行隐藏的次要设置」走这条，一直正常（sw>cw）；
 *   ② **被祖先裁**——胶囊 sw==cw==58 却被切短，只认①就永远判 false（没 title、
 *      点按没反应）。两条取或。
 */

const base: TruncateProbe = { scrollWidth: 100, clientWidth: 100, right: 100, clipRight: null }

test('①自己盒子在裁：scrollWidth > clientWidth 即截断', () => {
  assert.equal(isTruncatedProbe({ ...base, scrollWidth: 142, clientWidth: 122 }), true)
  // 用户 live 的正常样本：界面缩放 sw=57 cw=36
  assert.equal(isTruncatedProbe({ ...base, scrollWidth: 57, clientWidth: 36 }), true)
})

test('②被祖先裁：自身 sw==cw 但右缘超出祖先内容右缘', () => {
  // 用户 live 的胶囊：sw==cw==58，却被切短 → 祖先内容右缘 50
  assert.equal(
    isTruncatedProbe({ ...base, scrollWidth: 58, clientWidth: 58, right: 58, clipRight: 50 }),
    true
  )
  // 右缘正好贴着祖先内容右缘 → 不算
  assert.equal(isTruncatedProbe({ ...base, right: 50, clipRight: 50 }), false)
})

test('两条都不成立 → 没截断（不挂 title，避免满屏 title）', () => {
  assert.equal(isTruncatedProbe({ ...base, right: 40, clipRight: 50 }), false)
  assert.equal(isTruncatedProbe(base), false)
  // 没有会裁的祖先 + 自己也不裁
  assert.equal(isTruncatedProbe({ ...base, right: 999, clipRight: null }), false)
})

test('隐藏项（clientWidth=0）不算截断', () => {
  // teleport 进「更多」浮层的隐藏项在行里 display:none，量到全 0——
  // 不能因此判截断（它们在图里应该是全文）
  assert.equal(
    isTruncatedProbe({ scrollWidth: 0, clientWidth: 0, right: 0, clipRight: null }),
    false
  )
})

test('回归：①那条老路的行为不变（界面缩放 / 设置行标签）', () => {
  // 老判定 = ①；新判定在①上必须完全一致
  const old = (p: TruncateProbe): boolean => p.clientWidth > 0 && p.scrollWidth > p.clientWidth + 1
  for (const sw of [0, 36, 37, 57, 122, 142]) {
    for (const cw of [0, 36, 122]) {
      const p = { ...base, scrollWidth: sw, clientWidth: cw }
      assert.equal(isTruncatedProbe(p), old(p), `sw=${sw} cw=${cw} 应与老判定一致`)
    }
  }
})
