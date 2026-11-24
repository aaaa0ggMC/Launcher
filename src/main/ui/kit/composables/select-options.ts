/**
 * KitSelect 的 items → 选项映射（纯函数，可单测）。
 *
 * 为什么抽出来：原实现只认 `{title, value}` 两个键，而设置页「背景」下拉传的是
 * `{id, name, description}` + `item-title="name"` / `item-value="id"`（与 v-select
 * 同名 attrs 指路）——键对不上时所有选项 title=''、value=undefined、选中项永远匹配
 * 不到、触发器文字恒空、选完落回默认值（静态审计 A-1，P0）。
 *
 * 口径（与 v-select 的 item-title / item-value 对齐）：
 * - 字符串数组：`{ title: raw, value: raw }`；
 * - 对象数组：title 取 `item-title` 指的键（缺省 `title`），value 取 `item-value`
 *   指的键（缺省 `value`）；value 键缺失时回落 `value` → `title` → title 本身。
 */

export interface SelectOption {
  title: string
  value: unknown
}

export function mapSelectOptions(
  items: readonly unknown[] | undefined,
  titleKey = 'title',
  valueKey = 'value'
): SelectOption[] {
  return (items ?? []).map((raw) => {
    if (raw !== null && typeof raw === 'object') {
      const o = raw as Record<string, unknown>
      const title = o[titleKey]
      const value = valueKey in o ? o[valueKey] : (o.value ?? o.title)
      return { title: String(title ?? ''), value: value ?? title }
    }
    return { title: String(raw), value: raw }
  })
}
