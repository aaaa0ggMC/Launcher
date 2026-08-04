import type { CommandSpec } from '../../main/process/commands/types'
import { getMirrorInfo, toggleMirror, testMirrors } from './service'
import { makeLogger } from '../../main/process/logger'

const log = makeLogger('mirror')

export default [
  {
    name: 'mirror.get',
    description: '当前镜像源列表与状态',
    usage: 'mirror.get',
    run: async () => {
      const result = await getMirrorInfo()
      log.info('mirror.get', { ok: true, count: result.mirrors.length })
      return result
    }
  },
  {
    name: 'mirror.toggle',
    description: '启用/禁用镜像源 (--name --enable true|false, pkexec)',
    usage: 'mirror.toggle --name USTC --enable true',
    run: async (ctx) => {
      const name = String(ctx.named.name ?? '')
      const enabled = ctx.named.enable === 'true' || ctx.named.enable === true
      if (!name) {
        log.warn('mirror.toggle', { ok: false, error: 'missing name' })
        return { ok: false, error: '需要 --name' }
      }
      const result = await toggleMirror(name, enabled)
      log.info('mirror.toggle', { ok: true, name, enabled })
      return result
    }
  },
  {
    name: 'mirror.test',
    description: '测试所有镜像源连通性与速度',
    usage: 'mirror.test',
    run: async () => {
      const result = await testMirrors()
      log.info('mirror.test', {
        ok: true,
        okCount: result.filter((r) => r.ok).length,
        failed: result.filter((r) => !r.ok).length
      })
      return result
    }
  }
] satisfies CommandSpec[]
