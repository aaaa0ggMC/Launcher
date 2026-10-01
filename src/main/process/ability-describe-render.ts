import type { AbilityDescription } from './ability-describe'

/**
 * Markdown 单元格转义：`|` 会切断表格行，换行同理；描述里两者都可能出现。
 */
function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim()
}

/**
 * 人类可读的能力清单（`ability.describe --format md`）。同一份元数据渲染一次，
 * 人和 agent 读到的内容因此不会漂移。
 */
export function renderAbilityMarkdown(d: AbilityDescription): string {
  const lines: string[] = []
  lines.push(`# ${d.id}`)
  lines.push('')
  lines.push(`- 平台: ${d.platforms.length ? d.platforms.join(', ') : '全平台'}`)
  lines.push(`- 提供能力: ${d.provides.length ? d.provides.join(', ') : '无'}`)
  lines.push(`- 依赖能力: ${d.dependencies.length ? d.dependencies.join(', ') : '无'}`)
  lines.push(`- 运行时状态: ${d.disabled ? '已禁用' : '已启用'}`)
  lines.push('')

  lines.push(`## 命令 (${d.commands.length})`)
  lines.push('')
  if (!d.commands.length) {
    lines.push('(无)')
  } else {
    lines.push('| 命令 | 说明 | 用法 | 状态 |')
    lines.push('| --- | --- | --- | --- |')
    for (const c of d.commands) {
      const status = c.available ? '可用' : `不可用: ${c.unavailableReason ?? '原因未知'}`
      lines.push(
        `| \`${c.name}\` | ${cell(c.description)} | ${c.usage ? `\`${cell(c.usage)}\`` : '—'} | ${cell(status)} |`
      )
    }
    // 表格放不下入口 / 关联 / 隐私声明，单独列一节，只列带内容的命令。
    const extras = d.commands.filter(
      (c) =>
        c.ui?.length || c.related?.length || c.privacy?.reads?.length || c.privacy?.requires?.length
    )
    if (extras.length) {
      lines.push('')
      lines.push('### 入口 / 相关 / 隐私')
      lines.push('')
      for (const c of extras) {
        const parts: string[] = []
        if (c.ui?.length) parts.push(`UI 入口: ${c.ui.join('; ')}`)
        if (c.related?.length) parts.push(`相关: ${c.related.map((r) => `\`${r}\``).join(', ')}`)
        const privacy: string[] = []
        if (c.privacy?.reads?.length) privacy.push(`读取 ${c.privacy.reads.join(', ')}`)
        if (c.privacy?.requires?.length) privacy.push(`需要许可 ${c.privacy.requires.join(', ')}`)
        if (privacy.length) parts.push(`隐私: ${privacy.join('；')}`)
        lines.push(`- \`${c.name}\` — ${parts.join('；')}`)
      }
    }
  }
  lines.push('')

  lines.push(`## 后台作业 (${d.jobs.length})`)
  lines.push('')
  if (!d.jobs.length) {
    lines.push('(无)')
  } else {
    for (const j of d.jobs) {
      lines.push(`- \`${j}\` — 启动: \`background.job --name ${j} --args <json>\``)
    }
  }
  lines.push('')

  lines.push(`## 帮助文档 (${d.help.length})`)
  lines.push('')
  if (!d.help.length) {
    lines.push('(无)')
  } else {
    for (const h of d.help) {
      lines.push(`- ${h.lang || '(基准)'} \`${h.path}\``)
    }
    if (d.helpHint) {
      lines.push('')
      lines.push(`读取: \`${d.helpHint}\``)
    }
  }
  lines.push('')
  return lines.join('\n')
}
