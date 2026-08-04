import type { CommandSpec } from './types'
import { systemStats } from '../system'

export default [
  {
    name: 'system.stats',
    description: '系统实时状态 (host/GPU/docker/RAM/disk)',
    usage: 'system.stats',
    run: async () => systemStats()
  }
] satisfies CommandSpec[]
