/**
 * 某个助手的「配置视图」：给现有的设置分区（插件 / MCP / 上下文 / 执行策略 / 形象…）用，
 * 它们照旧读写 `config.pluginEnabled` 这类字段，读写落到助手身上；其余字段（服务商、MCP
 * 服务器列表、插件配置值…）仍是全局配置。外壳持有的 config 是 reactive 的，助手对象也在它里面，
 * 所以依赖收集与自动保存都照常生效。
 */
import { ASSISTANT_KEYS } from '../../assistants'
import type { YayaAssistant, YayaConfig } from '../../types'

const SCOPED = new Set<string>([...ASSISTANT_KEYS, 'profile'])

export function scopedConfig(config: YayaConfig, assistant: YayaAssistant): YayaConfig {
  const a = assistant as unknown as Record<string, unknown>
  return new Proxy(config, {
    get(target, key, receiver) {
      if (typeof key === 'string' && SCOPED.has(key)) return a[key]
      return Reflect.get(target, key, receiver)
    },
    set(target, key, value, receiver) {
      if (typeof key === 'string' && SCOPED.has(key)) {
        a[key] = value
        return true
      }
      return Reflect.set(target, key, value, receiver)
    }
  })
}
