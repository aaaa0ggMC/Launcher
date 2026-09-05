<script setup lang="ts">
defineOptions({ name: 'cockpit-yarj-search-help' })

import { ref, inject } from 'vue'
import type { Ref } from 'vue'
import { translate } from '@ui/i18n'

defineProps<{
  modelValue: boolean
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', val: boolean): void
}>()

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)

const cheatsheet = [
  {
    category: 'GPS 与位置检索',
    items: [
      { syntax: ':corrected_gps', desc: '列出所有经过时空速度分析并纠正漂移的照片' },
      { syntax: ':guess_gps', desc: '列出所有处于时空推测中点阶段的照片' },
      {
        syntax: ':gps(long, lat, km)',
        desc: '检索指定经纬度半径内的照片（包含真实 GPS 与大致猜测）'
      },
      { syntax: ':has_gps', desc: '仅筛选具有真实 GPS 记录的照片' },
      { syntax: ':no_gps', desc: '筛选无定位且无猜测的照片' },
      { syntax: ':city("北京" or "上海")', desc: '拍摄城市（支持布尔组合）' },
      { syntax: ':country("日本")', desc: '拍摄国家/地区' }
    ]
  },
  {
    category: '标签与备注',
    items: [
      { syntax: ':tags("风景" and "夜景")', desc: '照片标签筛选（支持 and / or / not）' },
      { syntax: ':tags(猫, 狗)', desc: '逗号分隔多标签筛选（等同于 OR）' },
      { syntax: ':comment("暑假" and not "作业")', desc: '照片自定义备注检索' },
      { syntax: ':appendix(key, value)', desc: '自定义扩展元数据属性精确查询' }
    ]
  },
  {
    category: '相机与拍摄参数',
    items: [
      { syntax: ':camera("Sony" and "A7M4")', desc: '相机品牌与机身型号' },
      { syntax: ':lens("24-70" or "50mm")', desc: '镜头型号' },
      { syntax: ':iso(> 800)', desc: 'ISO 感光度数值大小范围比较' },
      { syntax: ':f(<= 2.8)', desc: '镜头光圈大小数值比较' },
      { syntax: ':focal(>= 50)', desc: '镜头等效焦距 (mm) 比较' }
    ]
  },
  {
    category: '日期与布尔划定',
    items: [
      { syntax: ':year(2024 or 2025)', desc: '拍摄年份筛选' },
      { syntax: ':date(2024-06-01..2024-08-31)', desc: '拍摄日期区间过滤' },
      {
        syntax: '"text and love" or "love and peace"',
        desc: '使用双引号划定精确词组并进行布尔逻辑 OR 组合'
      },
      { syntax: ':has_gps and not :video', desc: '排除视频文件，仅保留照片' }
    ]
  }
]
</script>

<template>
  <v-dialog
    :model-value="modelValue"
    max-width="720"
    scrollable
    @update:model-value="emit('update:modelValue', $event)"
  >
    <v-card class="rounded-xl border">
      <v-card-title class="d-flex align-center justify-space-between px-6 py-4">
        <div class="d-flex align-center ga-2">
          <v-icon color="primary" size="22">mdi-book-search-outline</v-icon>
          <span class="text-subtitle-1 font-weight-bold">
            {{ t('yarj.search.helpTitle', '高级搜索语法指南 (SEARCH.md)') }}
          </span>
        </div>
        <v-btn
          icon="mdi-close"
          variant="text"
          size="small"
          @click="emit('update:modelValue', false)"
        />
      </v-card-title>

      <v-divider />

      <v-card-text class="px-6 py-4" style="max-height: 520px">
        <div class="text-body-2 on-surface-variant mb-4">
          {{
            t(
              'yarj.search.helpSummary',
              '搜索框全面支持指令式语法与布尔组合。输入普通关键词时 100% 保持现有原汁原味检索；使用引号可划定精确词组，支持 and / or / not 及嵌套括号。'
            )
          }}
        </div>

        <div class="d-flex flex-column ga-5">
          <div v-for="(sec, sIdx) in cheatsheet" :key="sIdx">
            <div class="text-caption font-weight-bold text-primary mb-2">
              {{ sec.category }}
            </div>
            <v-table density="compact" class="rounded-lg border bg-surface-variant-opacity">
              <thead>
                <tr>
                  <th class="text-left font-mono font-weight-bold text-caption" style="width: 48%">
                    {{ t('yarj.search.thSyntax', '语法示例') }}
                  </th>
                  <th class="text-left text-caption">
                    {{ t('yarj.search.thDesc', '说明') }}
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(item, iIdx) in sec.items" :key="iIdx">
                  <td class="font-mono text-caption text-primary py-2 font-weight-medium">
                    <code>{{ item.syntax }}</code>
                  </td>
                  <td class="text-caption on-surface-variant py-2">
                    {{ item.desc }}
                  </td>
                </tr>
              </tbody>
            </v-table>
          </div>
        </div>
      </v-card-text>

      <v-divider />

      <v-card-actions class="px-6 py-3 justify-end ga-2">
        <v-btn variant="flat" color="primary" @click="emit('update:modelValue', false)">
          {{ t('yarj.search.close', '明白') }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
code {
  background: rgba(var(--v-theme-surface-bright), 0.5);
  padding: 2px 6px;
  border-radius: 4px;
  border: 1px solid rgba(var(--v-theme-surface-bright), 0.4);
}
</style>
