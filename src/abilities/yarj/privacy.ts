/**
 * yarj 的隐私 scope（隐私 SDK：src/main/process/privacy.ts）。
 *
 * 照片 GPS、运动航线、旅途站点能精确定位到一个人去过哪里（住址、行程）→ sensitive。
 * 行政区边界（LOD / hierarchy）与地理编码查询（坐标由调用方给出）不属于个人数据，不处理。
 */
import { definePrivacyScopes, shieldFields } from '../../main/process/privacy'
import type { CommandSpec } from '../../main/process/commands/types'

export const P = definePrivacyScopes('yarj', {
  location: {
    level: 'sensitive',
    label: 'yarj.privacy.location',
    description: 'yarj.privacy.location_desc'
  }
})

/** 坐标 / 地名类字段（数组形态的 label 是地图标注坐标，字符串 label 是普通文本）。 */
const LOCATION_KEYS = new Set([
  'lat',
  'lon',
  'lng',
  'latitude',
  'longitude',
  'center',
  'bounds',
  'coordinates',
  'arcCoordinates',
  'locationName',
  'formattedAddress',
  'address',
  'city',
  'lastView'
])

export function shieldLocation<T>(value: T): T {
  return shieldFields(value, (k, v) =>
    LOCATION_KEYS.has(k) || (k === 'label' && Array.isArray(v)) ? P.location : null
  )
}

/** 不含个人位置的命令（公开地理数据 / 调用方自己给出的坐标 / 纯状态）。 */
const PUBLIC = new Set([
  'yarj.lod',
  'yarj.lod-data',
  'yarj.lod-status',
  'yarj.hierarchy',
  'yarj.hierarchy-data',
  'yarj.hierarchy-status',
  'yarj.geocode',
  'yarj.reverse-geocode',
  'yarj.providers',
  'yarj.maps',
  'yarj.map-info',
  'yarj.cache-stats',
  'yarj.scan-status',
  'yarj.route-count'
])

/** 其余 yarj 命令：声明 reads，并对结果做位置脱敏（仅 agent 来源生效）。 */
export function withPrivacy(specs: CommandSpec[]): CommandSpec[] {
  return specs.map((s) => {
    if (s.privacy) return s
    if (PUBLIC.has(s.name)) return { ...s, privacy: {} }
    return {
      ...s,
      privacy: { reads: [P.location] },
      run: async (ctx) => shieldLocation(await s.run(ctx))
    }
  })
}
