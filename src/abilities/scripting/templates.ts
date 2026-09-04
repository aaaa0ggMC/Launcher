import type { ScriptTemplate } from './types'

export const SCRIPT_TEMPLATES: ScriptTemplate[] = [
  {
    id: 'api-ipc-demo',
    name: 'Cockpit IPC 快速上手',
    description: '演示如何声明配置参数、调用 Cockpit 命令、执行 Shell 与上报进度',
    language: 'ts',
    code: `/**
 * Cockpit Scripting Demo
 * 运行快捷键: Ctrl + Enter
 */

// 声明脚本可调参数 (自动映射至右侧栏)
export const config = {
  greeting: {
    type: 'string',
    label: '打招呼问候语',
    default: 'Hello from Cockpit Scripting!'
  },
  showStats: {
    type: 'boolean',
    label: '查询系统状态',
    default: true
  },
  concurrency: {
    type: 'slider',
    label: '任务并发数',
    min: 1,
    max: 10,
    default: 3
  }
}

cockpit.info('开始执行 Cockpit IPC 演示脚本...')
cockpit.log(\`参数读取: greeting="\${cockpit.config.greeting}", showStats=\${cockpit.config.showStats}\`)
cockpit.progress(10, '正在查询命令列表')

// 1. 查询当前系统注册的所有 Cockpit 命令
const commands = await cockpit.listCommands()
cockpit.log(\`当前系统已注册 \${commands.length} 个命令\`)

// 2. 调度具体的 Cockpit 命令 (如系统统计与日志)
if (cockpit.config.showStats) {
  cockpit.progress(40, '获取系统状态')
  try {
    const stats = await cockpit.command('dashboard.stats')
    cockpit.log('系统状态:', stats)
  } catch (e) {
    cockpit.warn('dashboard.stats 命令未开启或未满足平台条件')
  }
}

// 3. 执行 Shell 命令
cockpit.progress(70, '执行 Shell 命令')
const uname = await cockpit.sh('uname -a')
cockpit.log('内核信息:', uname.trim())

// 4. 模拟耗时操作与进度
cockpit.progress(90, '收尾工作中...')
await cockpit.sleep(400)

cockpit.progress(100, '完成')
cockpit.info('所有演示步骤执行完毕！')

// 返回值会直接展示在控制台底部
return {
  totalCommands: commands.length,
  greeting: cockpit.config.greeting,
  executedAt: new Date().toISOString()
}
`
  },
  {
    id: 'system-health',
    name: '系统健康巡检报告',
    description: '综合巡检系统统计、GPU 负载、Docker 容器与 systemd 服务状态',
    language: 'ts',
    code: `/**
 * 系统健康自动化巡检报告
 */
export const config = {
  checkGpu: {
    type: 'boolean',
    label: '检查 GPU 状态',
    default: true
  },
  checkDocker: {
    type: 'boolean',
    label: '检查 Docker 容器',
    default: true
  },
  checkSystemd: {
    type: 'boolean',
    label: '检查 Systemd 关键单元',
    default: true
  }
}

cockpit.info('====== 开始系统健康巡检 ======')
cockpit.progress(10, '检查系统负载')

const report: Record<string, unknown> = {}

// 1. 系统基础统计
try {
  const stats = (await cockpit.command('dashboard.stats')) as any
  report.stats = stats
  cockpit.log(
    \`CPU: \${stats.cpu?.usage ?? 'N/A'}% | 内存: \${stats.memory?.used ?? 'N/A'}/\${stats.memory?.total ?? 'N/A'}\`
  )
} catch (err) {
  cockpit.warn('获取系统统计失败:', err)
}

// 2. GPU 状态
if (cockpit.config.checkGpu) {
  cockpit.progress(35, '检查 GPU 状态')
  try {
    const gpus = (await cockpit.command('dashboard.gpu')) as any[]
    report.gpus = gpus
    if (Array.isArray(gpus) && gpus.length > 0) {
      for (const g of gpus) {
        cockpit.log(
          \`GPU [\${g.name}]: 温度 \${g.temperature}°C, 显存 \${g.memoryUsed}/\${g.memoryTotal} MB\`
        )
      }
    } else {
      cockpit.log('未检测到专用 GPU 或驱动')
    }
  } catch (err) {
    cockpit.log('GPU 查询跳过')
  }
}

// 3. Docker 容器状态
if (cockpit.config.checkDocker) {
  cockpit.progress(60, '检查 Docker 容器')
  try {
    const docker = (await cockpit.command('docker.list')) as any[]
    if (Array.isArray(docker)) {
      const running = docker.filter((c) => c.state === 'running')
      cockpit.log(\`Docker: 运行中 \${running.length} / 总计 \${docker.length} 个容器\`)
      report.docker = { running: running.length, total: docker.length }
    }
  } catch {
    cockpit.log('Docker 服务未运行或未安装')
  }
}

// 4. Systemd 关键服务巡检
if (cockpit.config.checkSystemd) {
  cockpit.progress(85, '检查 Systemd 服务')
  try {
    const units = (await cockpit.command('systemd.list')) as any[]
    if (Array.isArray(units)) {
      const failed = units.filter((u) => u.active === 'failed')
      if (failed.length > 0) {
        cockpit.error(
          \`发现 \${failed.length} 个异常 systemd 服务:\`,
          failed.map((u) => u.name)
        )
        report.failedUnits = failed
      } else {
        cockpit.info('所有监控的 Systemd 单元运行正常')
      }
    }
  } catch {
    cockpit.log('Systemd 单元查询跳过')
  }
}

cockpit.progress(100, '巡检完成')
cockpit.info('====== 巡检完成 ======')
return report
`
  },
  {
    id: 'mirror-bench',
    name: 'Arch 镜像源测速与分析',
    description: '通过 mirror.get 与 mirror.test 命令自动测试并列出最佳镜像源',
    language: 'ts',
    code: `/**
 * Arch Linux 镜像源测速工作流
 */
export const config = {
  topCount: {
    type: 'number',
    label: '显示前 N 个最优源',
    default: 5,
    min: 1,
    max: 20
  }
}

cockpit.info('正在读取 Pacman 镜像源配置...')
cockpit.progress(15, '获取当前配置')

try {
  const info = (await cockpit.command('mirror.get')) as any
  cockpit.log(\`当前检测到 \${info.mirrors?.length ?? 0} 个镜像源条目\`)

  cockpit.progress(40, '开始并发测速')
  cockpit.info('正在测试各镜像源延迟，请稍候...')

  const testResults = (await cockpit.command('mirror.test')) as any
  cockpit.progress(90, '分析测速结果')

  cockpit.log('测速完成，推荐最优源:')
  if (Array.isArray(testResults)) {
    const sorted = [...testResults].sort((a, b) => (a.latency ?? 9999) - (b.latency ?? 9999))
    const limit = Number(cockpit.config.topCount || 5)
    for (const m of sorted.slice(0, limit)) {
      cockpit.log(
        \`  - \${m.name}: \${m.latency ? m.latency + 'ms' : '连接超时'} (\${m.enabled ? '已启用' : '未启用'})\`
      )
    }
  }

  cockpit.progress(100, '完成')
  return testResults
} catch (e: any) {
  cockpit.error('镜像源测试失败:', e?.message || e)
  throw e
}
`
  },
  {
    id: 'wallpaper-rotator',
    name: '壁纸随机轮换工作流',
    description: '扫描指定目录中的壁纸文件，并随机应用一张到桌面',
    language: 'ts',
    code: `/**
 * 壁纸随机轮换工作流
 */
export const config = {
  wallpaperDir: {
    type: 'path',
    label: '壁纸目录',
    description: '搜索壁纸的本地文件夹路径',
    default: \`\${cockpit.env.HOME}/Pictures\`
  },
  autoNotify: {
    type: 'boolean',
    label: '切换后发送通知',
    default: true
  }
}

cockpit.info('正在扫描壁纸目录...')
cockpit.progress(20, '扫描壁纸库')

const targetDir = String(cockpit.config.wallpaperDir || \`\${cockpit.env.HOME}/Pictures\`)
let allWallpapers: any[] = []

try {
  const list = (await cockpit.command('display.wallpapers', { dir: targetDir })) as any[]
  if (Array.isArray(list) && list.length > 0) {
    allWallpapers = list
    cockpit.log(\`在 \${targetDir} 中找到 \${list.length} 张壁纸\`)
  }
} catch (e) {
  cockpit.warn(\`扫描 \${targetDir} 失败:\`, e)
}

if (allWallpapers.length === 0) {
  cockpit.warn('未在该路径找到壁纸，请检查右侧栏的壁纸目录配置')
  return { status: 'no_wallpapers_found' }
}

cockpit.progress(60, '选取随机壁纸')
const randomIndex = Math.floor(Math.random() * allWallpapers.length)
const picked = allWallpapers[randomIndex]
cockpit.info(\`随机选中壁纸: \${picked.name || picked.path}\`)

cockpit.progress(80, '应用壁纸')
try {
  await cockpit.command('display.wallpaper', { path: picked.path })
  if (cockpit.config.autoNotify) {
    await cockpit.notify('壁纸已轮换', \`已应用: \${picked.name || picked.path}\`)
  }
  cockpit.progress(100, '壁纸已应用')
  cockpit.info('桌面壁纸切换成功！')
  return { applied: picked.path }
} catch (err) {
  cockpit.error('应用壁纸失败:', err)
  throw err
}
`
  },
  {
    id: 'batch-task-pipeline',
    name: '数据管道与本地归档',
    description: '抓取外部接口/系统日志，清洗转换并保存至本地存储',
    language: 'ts',
    code: `/**
 * 数据归档与通知管道工作流
 */
export const config = {
  logLimit: {
    type: 'number',
    label: '抓取日志条数',
    default: 50,
    min: 10,
    max: 200
  },
  archiveName: {
    type: 'string',
    label: '归档文件名前缀',
    default: 'logs-archive'
  }
}

cockpit.info('启动数据管道工作流...')
cockpit.progress(10, '抓取系统日志')

const limit = Number(cockpit.config.logLimit || 50)
const logs = (await cockpit.command('logs.query', { limit })) as any[]
cockpit.log(\`成功提取 \${Array.isArray(logs) ? logs.length : 0} 条最近日志\`)

cockpit.progress(40, '分析日志等级分布')
const summary: Record<string, number> = { info: 0, warn: 0, error: 0 }
if (Array.isArray(logs)) {
  for (const item of logs) {
    const lvl = item.level || 'info'
    summary[lvl] = (summary[lvl] || 0) + 1
  }
}
cockpit.log('日志统计结果:', summary)

cockpit.progress(75, '写入本地归档')
const prefix = String(cockpit.config.archiveName || 'logs-archive')
const archivePath = \`\${cockpit.env.HOME}/.config/LinuxCockpit/\${prefix}-\${Date.now()}.json\`
await cockpit.fs.writeFile(
  archivePath,
  JSON.stringify({ summary, timestamp: Date.now() }, null, 2)
)
cockpit.info(\`已归档至: \${archivePath}\`)

cockpit.progress(95, '发送通知')
try {
  await cockpit.notify('工作流执行完成', \`已成功归档日志，共发现 \${summary.error} 条错误\`)
} catch {}

cockpit.progress(100, '已完成')
return { summary, archivePath }
`
  }
]
