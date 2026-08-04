import type { CommandSpec } from './types'
import { gpuInfo, readPmValue, togglePm } from '../gpu'

export default [
  {
    name: 'hardware.gpu',
    description: 'GPU 信息 (nvidia-smi)',
    usage: 'hardware.gpu',
    run: async () => gpuInfo()
  },
  {
    name: 'hardware.pm',
    description: '读取 NVreg_PreserveVideoMemoryAllocations',
    usage: 'hardware.pm',
    run: async () => readPmValue()
  },
  {
    name: 'hardware.pm-toggle',
    description: '切换 0↔1 (pkexec, 重启生效)',
    usage: 'hardware.pm-toggle',
    run: async () => togglePm()
  }
] satisfies CommandSpec[]
