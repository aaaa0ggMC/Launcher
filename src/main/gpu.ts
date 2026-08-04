import { execFile } from 'child_process'
import { readFile } from 'fs/promises'
import { join } from 'path'
import type { GpuInfo } from '../shared/types'
import { NVIDIA_PM_CONF, SCRIPTS_DIR } from './paths'
import { run } from './util'

export async function gpuInfo(): Promise<GpuInfo[]> {
  const out = await run('nvidia-smi', [
    '--query-gpu=name,driver_version,memory.total,memory.used,utilization.gpu,temperature.gpu,fan.speed,power.draw,power.limit',
    '--format=csv,noheader,nounits'
  ]).catch(() => '')
  const gpus: GpuInfo[] = []
  for (const line of out.split('\n')) {
    const t = line.trim()
    if (!t) continue
    const cols = t.split(',').map((c) => c.trim())
    if (cols.length >= 6) {
      // nvidia-smi reports `[N/A]` for fields the GPU doesn't expose (e.g. fan
      // speed on fanless cards, power draw without power monitoring). Normalize
      // those to undefined so the UI simply omits the stat instead of showing
      // `风扇 [N/A]%`.
      const vramTotal = clean(cols[2]) ?? '0'
      const vramUsed = clean(cols[3]) ?? '0'
      const vramTotalNum = Number(vramTotal)
      const vramUsedNum = Number(vramUsed)
      const vramPercent = vramTotalNum > 0 ? Math.round((vramUsedNum / vramTotalNum) * 100) : 0
      const fan = clean(cols[6])
      const power = clean(cols[7])
      const powerLimit = clean(cols[8])
      gpus.push({
        name: clean(cols[0]) ?? 'GPU',
        driver: clean(cols[1]) ?? '—',
        vram: `${vramUsed} / ${vramTotal} MB`,
        vramTotal: `${vramTotal} MB`,
        vramUsed: `${vramUsed} MB`,
        vramPercent,
        usage: clean(cols[4]) ? `${clean(cols[4])}%` : '—',
        temp: clean(cols[5]) ? `${clean(cols[5])}°C` : '—',
        fanSpeed: fan ? `${fan}%` : undefined,
        power: power ? `${power}W` : undefined,
        powerLimit: powerLimit ? `${powerLimit}W` : undefined
      })
    }
  }
  return gpus
}

/** `[N/A]` / empty → undefined, otherwise the trimmed raw value. */
function clean(v: string | undefined): string | undefined {
  const t = (v ?? '').trim()
  return t && !/\[N\/A\]/i.test(t) ? t : undefined
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
