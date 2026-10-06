import type { CommandSpec } from '../../../../main/process/commands/types'
import { notifyModelMetaChanged } from './index'
import { deleteMeta, listMeta, normalizeMetaPatch, setMeta } from './store'

function obj(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as Record<string, unknown>
    } catch {
      return {}
    }
  }
  return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
}

const commands: CommandSpec[] = [
  {
    name: 'yaya.model-meta-list',
    description: '已记录的模型元数据（价格 / 上下文长度）',
    usage: 'yaya.model-meta-list',
    ui: ['设置 → YAYA → 插件 → 模型元数据'],
    related: ['yaya.model-meta-set', 'yaya.model-meta-delete'],
    run: () => ({ entries: listMeta() })
  },
  {
    name: 'yaya.model-meta-set',
    // AI 走 models_set 工具（要用户确认）；这条是用户界面的入口
    privacy: { agent: 'deny' },
    description: '写入 / 修改一个模型的元数据（合并写入，null 清除字段）',
    usage:
      'yaya.model-meta-set --provider <服务商 id 或 *> --model <模型> --meta <{input,cachedInput,output,currency,contextWindow,maxOutput,source,note} JSON>',
    run: (ctx) => {
      const provider = String(ctx.named.provider ?? '*') || '*'
      const entry = setMeta(
        provider,
        String(ctx.named.model ?? ''),
        normalizeMetaPatch(obj(ctx.named.meta)),
        'user'
      )
      notifyModelMetaChanged()
      return { entry }
    }
  },
  {
    name: 'yaya.model-meta-delete',
    // 删除只有用户能做
    privacy: { agent: 'deny' },
    description: '删除一个模型的元数据',
    usage: 'yaya.model-meta-delete --provider <服务商 id 或 *> --model <模型>',
    run: (ctx) => {
      const ok = deleteMeta(String(ctx.named.provider ?? '*') || '*', String(ctx.named.model ?? ''))
      if (ok) notifyModelMetaChanged()
      return { ok }
    }
  }
]
export default commands
