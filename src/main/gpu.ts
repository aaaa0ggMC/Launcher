import { execFile } from 'child_process'
import { readFile } from 'fs/promises'
import { join } from 'path'
import type { GpuInfo } from '../shared/types'
import { NVIDIA_PM_CONF, SCRIPTS_DIR } from './paths'
import { run } from './util'

export async function gpuInfo(): Promise<GpuInfo[]> {
  const out = await run(
    'nvidia-smi',
    [
      '--query-gpu=name,driver_version,memory.total,memory.used,utilization.gpu,temperature.gpu',
      '--format=csv,noheader,nounits'
    ]
  ).catch(() => '')
  const gpus: GpuInfo[] = []
  for (const line of out.split('\n')) {
    const t = line.trim()
    if (!t) continue
    const cols = t.split(',').map((c) => c.trim())
    if (cols.length >= 6) {
      gpus.push({
        name: cols[0],
        driver: cols[1],
        vram: `${cols[3]} / ${cols[2]} MB`,
        usage: `${cols[4]}%`,
        temp: `${cols[5]}°C`
      })
    }
  }
  return gpus
}

export async function readPmValue(): Promise<0 | 1 | null> {
  const raw = await readFile(NVIDIA_PM_CONF, 'utf-8').catch(() => '')
  if (/NVreg_PreserveVideoMemoryAllocations=1/.test(raw)) return 1
  if (/NVreg_PreserveVideoMemoryAllocations=0/.test(raw)) return 0
  return null
}

/** Toggle NVreg_PreserveVideoMemoryAllocations 0↔1 via pkexec (reboot required). */
export async function togglePm(): Promise<0 | 1 | null> {
  const script = join(SCRIPTS_DIR, 'nvidia-pm-toggle.sh')
  const result = await new Promise<string>((resolve, reject) => {
    execFile('pkexec', [script], { encoding: 'utf-8' }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message))
      else resolve(stdout.trim())
    })
  })
  if (result === '0' || result === '1') return result === '1' ? 1 : 0
  return null
}
