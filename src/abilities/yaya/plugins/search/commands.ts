import type { CommandSpec } from '../../../../main/process/commands/types'
import { t } from '../../../../main/process/i18n'
import { loadYayaConfig } from '../../services/config'
import { getPlugin, pluginConfigValues } from '../../services/plugins/registry'
import { runSearch } from './index'

/** 设置页「测试搜索」的超时：引擎卡住也要给用户一个结论 */
const TEST_TIMEOUT_MS = 30_000

const commands: CommandSpec[] = [
  {
    name: 'yaya.search-test',
    description:
      '用当前网页搜索插件的配置（模式 / 引擎 / 密钥）实际搜索一次，返回结果与每个引擎的成败、耗时。用来确认配置能不能用',
    usage: 'yaya.search-test --query <关键词>',
    ui: ['设置 → YAYA → 插件 → 网页搜索 → 测试搜索'],
    related: ['yaya.plugin-config-set'],
    // 会用用户的密钥消耗搜索额度：只许用户本人点
    privacy: { agent: 'deny' },
    run: async (ctx) => {
      const plugin = getPlugin('search')
      if (!plugin) throw new Error(t('yaya.plugin.cmd_err_unknown_plugin', '插件不存在：search'))
      const values = pluginConfigValues(plugin, loadYayaConfig())
      const started = Date.now()
      const out = await runSearch(
        values,
        String(ctx.named.query ?? ''),
        undefined,
        AbortSignal.timeout(TEST_TIMEOUT_MS)
      )
      const ms = Date.now() - started
      if ('error' in out) return { ok: false, error: out.error, ms }
      const ok = out.display.hits.length > 0 || !!out.display.answer
      return { ok, ms, display: out.display }
    }
  }
]
export default commands
