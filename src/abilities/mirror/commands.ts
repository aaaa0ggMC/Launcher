import type { CommandSpec } from '../../main/process/commands/types'
import { getMirrorInfo, toggleMirror, testMirrors } from './service'

export default [
  {
    name: 'mirror.get',
    description: '当前镜像源列表与状态',
    usage: 'mirror.get',
    run: async () => getMirrorInfo()
  },
  {
    name: 'mirror.toggle',
    description: '启用/禁用镜像源 (--name --enable true|false, pkexec)',
    usage: 'mirror.toggle --name USTC --enable true',
    run: async (ctx) => {
      const name = String(ctx.named.name ?? '')
      const enabled = ctx.named.enable === 'true' || ctx.named.enable === true
      if (!name) return { ok: false, error: '需要 --name' }
      return await toggleMirror(name, enabled)
    }
  },
  {
    name: 'mirror.test',
    description: '测试所有镜像源连通性与速度',
    usage: 'mirror.test',
    run: async () => testMirrors()
  }
] satisfies CommandSpec[]
