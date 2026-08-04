import type { CommandSpec } from './types'
import { listDocker, dockerAction } from '../docker'

export default [
  {
    name: 'docker.list',
    description: '列出 Docker 容器',
    usage: 'docker.list',
    run: async () => listDocker()
  },
  {
    name: 'docker.action',
    description: '启动/停止/重启容器 (--name --action)',
    usage: 'docker.action --name new-api --action start',
    run: async (ctx) => {
      const name = String(ctx.named.name ?? '')
      const action = String(ctx.named.action ?? '') as 'start' | 'stop' | 'restart'
      if (!name) return { ok: false, error: '需要 --name' }
      return await dockerAction(name, action)
    }
  }
] satisfies CommandSpec[]
