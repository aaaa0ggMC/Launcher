import type { ToolDefinition, ToolField } from '../../types'
const zone: ToolField = {
  key: 'zone',
  label: '时区',
  labelEn: 'Time zone',
  type: 'select',
  default: 'UTC',
  options: [
    { title: 'UTC', value: 'UTC' },
    { title: '本地 / Local', value: 'local' },
    { title: 'Asia/Shanghai', value: 'Asia/Shanghai' },
    { title: 'Asia/Tokyo', value: 'Asia/Tokyo' },
    { title: 'America/New_York', value: 'America/New_York' },
    { title: 'Europe/London', value: 'Europe/London' }
  ]
}
const unit: ToolField = {
  key: 'unit',
  label: '时间戳单位',
  labelEn: 'Timestamp unit',
  type: 'select',
  default: 's',
  options: [
    { title: '秒 / Seconds', value: 's' },
    { title: '毫秒 / Milliseconds', value: 'ms' },
    { title: '微秒 / Microseconds', value: 'us' },
    { title: '纳秒 / Nanoseconds', value: 'ns' }
  ]
}
const date: ToolField = {
  key: 'date',
  label: '日期时间',
  labelEn: 'Date and time',
  type: 'text',
  default: '2026-10-01 12:00:00',
  hint: 'YYYY-MM-DD HH:mm:ss；或带偏移的 ISO 8601'
}
const descriptionsEn: Record<string, string> = {
  'epoch-converter':
    'Convert Unix seconds, milliseconds, microseconds and nanoseconds to dates with exact sub-millisecond precision.',
  'epoch-batch': 'Convert one value per line and report errors separately.',
  'date-difference': 'Calculate elapsed time between two explicit dates.',
  'date-add': 'Add or subtract elapsed seconds, minutes, hours or 24-hour days.',
  'period-boundary':
    'Find calendar period boundaries in a chosen time zone, including DST changes.',
  duration: 'Convert seconds to days, hours, minutes, seconds and an ISO 8601 duration.',
  'special-epoch':
    'Convert FILETIME, .NET ticks, WebKit, OADate, Discord Snowflake and hexadecimal Unix time.',
  'world-clock': 'Show the same instant in multiple IANA time zones.'
}
const tool = (
  id: string,
  title: string,
  titleEn: string,
  description: string,
  fields: ToolField[],
  keywords: string[]
): ToolDefinition => ({
  id,
  title,
  titleEn,
  description,
  descriptionEn: descriptionsEn[id],
  category: 'time',
  icon: 'mdi-clock-outline',
  fields,
  keywords
})
export const definitions: ToolDefinition[] = [
  {
    ...tool(
      'epoch-converter',
      'Epoch 时间戳转换',
      'Epoch Converter',
      '精确转换秒、毫秒、微秒、纳秒与日期；保留亚毫秒精度。',
      [
        {
          key: 'direction',
          label: '方向',
          labelEn: 'Direction',
          type: 'select',
          default: 'to-date',
          options: [
            { title: '时间戳 → 日期 / Timestamp to date', value: 'to-date' },
            { title: '日期 → 时间戳 / Date to timestamp', value: 'to-epoch' }
          ]
        },
        { key: 'timestamp', label: '时间戳', labelEn: 'Timestamp', type: 'text', default: '0' },
        unit,
        date,
        zone,
        {
          key: 'disambiguation',
          label: '夏令时重复时刻',
          labelEn: 'DST overlap',
          type: 'select',
          default: 'reject',
          options: [
            { title: '报错 / Reject', value: 'reject' },
            { title: '较早 / Earlier', value: 'earlier' },
            { title: '较晚 / Later', value: 'later' }
          ]
        }
      ],
      ['epochconverter', 'epoch converter', 'unix', 'timestamp', '时间截', '时间戳', 'UTC', '时区']
    ),
    view: 'epoch'
  },
  tool(
    'epoch-batch',
    '批量时间戳转换',
    'Batch Epoch Converter',
    '每行转换一个值，逐行报告错误。',
    [
      {
        key: 'input',
        label: '时间戳（每行一个）',
        labelEn: 'One timestamp per line',
        type: 'textarea',
        default: '0\n1790812800'
      },
      unit,
      zone
    ],
    ['batch', 'epoch', '批量', 'timestamp']
  ),
  tool(
    'date-difference',
    '日期差值',
    'Date Difference',
    '计算两个明确日期之间的实际经过时间。',
    [
      {
        ...date,
        key: 'start',
        label: '起始日期',
        labelEn: 'Start',
        default: '2026-01-01 00:00:00'
      },
      { ...date, key: 'end', label: '结束日期', labelEn: 'End', default: '2026-10-01 00:00:00' },
      zone
    ],
    ['date', 'duration', '日期差', '天数']
  ),
  tool(
    'date-add',
    '日期加减',
    'Date Calculator',
    '按实际经过的秒、分钟、小时或天加减日期。',
    [
      date,
      { key: 'amount', label: '增减数值', labelEn: 'Amount', type: 'number', default: 1 },
      {
        key: 'period',
        label: '单位',
        labelEn: 'Unit',
        type: 'select',
        default: 'day',
        options: [
          { title: '秒 / Seconds', value: 'second' },
          { title: '分钟 / Minutes', value: 'minute' },
          { title: '小时 / Hours', value: 'hour' },
          { title: '天（24小时）/ Days (24h)', value: 'day' }
        ]
      },
      zone
    ],
    ['date calculator', '日期加减', '时间计算']
  ),
  tool(
    'period-boundary',
    '年／月／日时间范围',
    'Period Boundaries',
    '计算指定时区日历区间的起点与终点，正确处理夏令时。',
    [
      date,
      {
        key: 'period',
        label: '区间',
        labelEn: 'Period',
        type: 'select',
        default: 'day',
        options: [
          { title: '日 / Day', value: 'day' },
          { title: '月 / Month', value: 'month' },
          { title: '年 / Year', value: 'year' }
        ]
      },
      zone
    ],
    ['epoch', 'start end', '开始结束', '年初', '月初', '日初']
  ),
  tool(
    'duration',
    '秒数与时长转换',
    'Duration Converter',
    '将秒数转换为天、小时、分钟、秒和 ISO 8601 时长。',
    [{ key: 'seconds', label: '秒数', labelEn: 'Seconds', type: 'text', default: '90061' }],
    ['seconds', 'duration', 'ISO 8601', '时长']
  ),
  tool(
    'special-epoch',
    '特殊时间戳转换',
    'Timestamp Formats',
    '转换 Windows FILETIME、.NET ticks、WebKit、Excel、Discord Snowflake 与 Unix 时间。',
    [
      {
        key: 'format',
        label: '格式',
        labelEn: 'Format',
        type: 'select',
        default: 'filetime',
        options: [
          { title: 'Windows FILETIME / LDAP (100ns)', value: 'filetime' },
          { title: '.NET ticks (100ns)', value: 'dotnet' },
          { title: 'Chrome / WebKit (µs)', value: 'webkit' },
          { title: 'Excel OADate (days)', value: 'excel' },
          { title: 'Discord Snowflake ID', value: 'discord' },
          { title: 'Unix hexadecimal (seconds)', value: 'hex' }
        ]
      },
      {
        key: 'value',
        label: '数值',
        labelEn: 'Value',
        type: 'text',
        default: '116444736000000000'
      },
      zone
    ],
    ['epochconverter', 'FILETIME', 'LDAP', 'ticks', 'snowflake', 'excel', 'webkit', 'hex']
  ),
  tool(
    'world-clock',
    '世界时钟',
    'World Clock',
    '显示同一时刻在多个 IANA 时区的日期时间。',
    [
      {
        key: 'date',
        label: 'ISO 日期（空白使用现在）',
        labelEn: 'ISO date (empty = now)',
        type: 'text',
        default: ''
      },
      {
        key: 'zones',
        label: '时区（每行一个）',
        labelEn: 'One IANA zone per line',
        type: 'textarea',
        default: 'UTC\nAsia/Shanghai\nAsia/Tokyo\nEurope/London\nAmerica/New_York'
      }
    ],
    ['world clock', 'timezone', '时区', '世界时钟']
  )
]
