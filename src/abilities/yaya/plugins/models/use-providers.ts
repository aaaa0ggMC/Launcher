/** 渲染端：服务商 id → 名字（编辑对话框的服务商下拉、表格里的服务商名） */
import { ref } from 'vue'

const providers = ref<{ id: string; name: string }[]>([])
let loaded = false

export function useProviders(): typeof providers {
  if (!loaded) {
    loaded = true
    void window.cockpit
      .command('yaya.config-get')
      .then((c) => {
        const list = (c as { providers?: { id: string; name: string }[] }).providers ?? []
        providers.value = list.map((p) => ({ id: p.id, name: p.name }))
      })
      .catch(() => {
        loaded = false
      })
  }
  return providers
}

export function providerName(list: { id: string; name: string }[], id: string): string {
  if (!id || id === '*') return ''
  return list.find((p) => p.id === id)?.name ?? id
}
