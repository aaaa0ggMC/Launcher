import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mapSelectOptions } from './select-options'

/**
 * KitSelect items 映射契约（静态审计 A-1）。
 * 出事的形状：设置页「背景」下拉 items 是 {id,name,description} + item-title="name"
 * + item-value="id"，旧映射只读 {title,value} → 选项全空、选中值 undefined、
 * 触发器恒空。这里钉住「item-title/item-value 指路」这条数据流。
 */

test('对象数组 + item-title/item-value 指路（设置页「背景」的真实形状）', () => {
  const items = [
    { id: 'transparent', name: '透明', description: '无背景' },
    { id: 'image', name: '图片背景', description: '壁纸' }
  ]
  const opts = mapSelectOptions(items, 'name', 'id')
  assert.deepEqual(opts, [
    { title: '透明', value: 'transparent' },
    { title: '图片背景', value: 'image' }
  ])
})

test('缺省键 title / value（旧形状不回归）', () => {
  const opts = mapSelectOptions([
    { title: '流畅', value: 'low' },
    { title: '高', value: 'high' }
  ])
  assert.deepEqual(opts, [
    { title: '流畅', value: 'low' },
    { title: '高', value: 'high' }
  ])
})

test('字符串数组：title 与 value 都是原文', () => {
  assert.deepEqual(mapSelectOptions(['dark', 'light']), [
    { title: 'dark', value: 'dark' },
    { title: 'light', value: 'light' }
  ])
})

test('value 键缺失时回落 value→title→title 本身；title 键缺失不炸', () => {
  assert.deepEqual(mapSelectOptions([{ name: 'x' }], 'name', 'id'), [{ title: 'x', value: 'x' }])
  assert.deepEqual(mapSelectOptions([{ title: 'y' }]), [{ title: 'y', value: 'y' }])
  assert.deepEqual(mapSelectOptions([{}]), [{ title: '', value: undefined }])
})

test('items 缺省 / 空数组 → 空选项', () => {
  assert.deepEqual(mapSelectOptions(undefined), [])
  assert.deepEqual(mapSelectOptions([]), [])
})
