<script setup lang="ts">
defineOptions({ name: 'cockpit-yarj-photo-filter-rules-manager' })

import { ref, inject } from 'vue'
import type { Ref } from 'vue'
import { translate } from '@ui/i18n'
import type { PhotoFilterRule, PhotoFilterOperator } from '../types'
import { parseValuesList } from '../photo-filter'

const props = defineProps<{
  modelValue?: PhotoFilterRule[]
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', val: PhotoFilterRule[]): void
  (e: 'change'): void
}>()

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)

const AI_TYPES = [
  'Document',
  'Blackboard',
  'Screenshot',
  'Portrait',
  'GroupPhoto',
  'Scenery',
  'Architecture',
  'Food',
  'Pet',
  'Object',
  'Interior',
  'Activity'
]

const COMMON_FIELDS = [
  { title: 'AI 识别类型 (ai_generated.type)', value: 'ai_generated.type' },
  { title: 'AI 识别简述 (ai_generated.brief)', value: 'ai_generated.brief' },
  { title: 'OCR 文字识别 (ai_generated.ocr)', value: 'ai_generated.ocr' },
  { title: '相机厂商 (camera_make)', value: 'camera_make' },
  { title: '相机型号 (camera_model)', value: 'camera_model' },
  { title: '拍摄时间 (taken_at)', value: 'taken_at' },
  { title: '标签列表 (appendix.tags)', value: 'appendix.tags' },
  { title: '日记备注 (appendix.comment)', value: 'appendix.comment' },
  { title: '文件路径 (path)', value: 'path' },
  { title: '文件大小 (file_size)', value: 'file_size' },
  { title: 'GPS 纬度 (gps_lat)', value: 'gps_lat' },
  { title: 'GPS 经度 (gps_lon)', value: 'gps_lon' }
]

const OPERATORS: { title: string; value: PhotoFilterOperator }[] = [
  { title: '不属于 (not in)', value: 'not_in' },
  { title: '属于 (in)', value: 'in' },
  { title: '包含关键词 (contains)', value: 'contains' },
  { title: '不包含 (not contains)', value: 'not_contains' },
  { title: '等于 (==)', value: 'equals' },
  { title: '不等于 (!=)', value: 'not_equals' },
  { title: '非空 (is not empty)', value: 'is_not_empty' },
  { title: '为空 (is empty)', value: 'is_empty' },
  { title: '大于 (>)', value: 'gt' },
  { title: '小于 (<)', value: 'lt' }
]

function addFilterRule(): void {
  const next = [...(props.modelValue || [])]
  next.push({
    id: `rule_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    enabled: true,
    field: 'ai_generated.type',
    operator: 'not_in',
    value: '["Document", "Blackboard"]'
  })
  emit('update:modelValue', next)
  emit('change')
}

function removeFilterRule(index: number): void {
  const next = [...(props.modelValue || [])]
  next.splice(index, 1)
  emit('update:modelValue', next)
  emit('change')
}

function toggleAiTypeInRule(rule: PhotoFilterRule, typeName: string): void {
  const currentList = parseValuesList(rule.value || '')
  const idx = currentList.findIndex((s) => s.toLowerCase() === typeName.toLowerCase())
  if (idx >= 0) {
    currentList.splice(idx, 1)
  } else {
    currentList.push(typeName)
  }
  rule.value = JSON.stringify(currentList)
  emit('change')
}
</script>

<template>
  <v-card rounded="lg" variant="tonal" class="card-fill">
    <v-card-title class="text-subtitle-2 d-flex align-center justify-space-between flex-wrap ga-2">
      <span>{{ t('yarj.prefs.filtersTitle', '照片展示高级筛选规则 (Photo Filters)') }}</span>
      <v-btn color="primary" variant="tonal" prepend-icon="mdi-plus" @click="addFilterRule">
        {{ t('yarj.prefs.addFilter', '添加筛选条件') }}
      </v-btn>
    </v-card-title>
    <v-card-text>
      <div class="text-caption on-surface-variant mb-3">
        {{
          t(
            'yarj.prefs.filtersDesc',
            '支持类似数据库的通用字段过滤，隐藏文档、黑板或特定类型的图片，仅展示符合条件的内容'
          )
        }}
      </div>

      <div v-if="!modelValue?.length" class="text-center py-6 text-disabled text-body-2">
        {{ t('yarj.prefs.noFilters', '当前未设置任何筛选规则，地图将呈现全部含定位照片。') }}
      </div>

      <div v-else class="d-flex flex-column ga-4">
        <v-card
          v-for="(rule, idx) in modelValue"
          :key="rule.id || idx"
          variant="outlined"
          class="pa-4 rounded-lg"
          :style="{ opacity: rule.enabled ? 1 : 0.6 }"
        >
          <div class="d-flex align-center justify-space-between pb-2 mb-3 border-b">
            <div class="d-flex align-center ga-3">
              <v-switch
                v-model="rule.enabled"
                color="primary"
                density="compact"
                hide-details
                @update:model-value="emit('change')"
              />
              <span class="text-body-2 font-weight-bold">
                {{ t('yarj.prefs.rule', '规则') }} #{{ idx + 1 }}
              </span>
              <v-chip
                size="small"
                :color="rule.enabled ? 'primary' : 'default'"
                variant="tonal"
                class="filter-chip"
              >
                {{
                  rule.enabled
                    ? t('yarj.prefs.enabled', '已启用')
                    : t('yarj.prefs.disabled', '已禁用')
                }}
              </v-chip>
            </div>
            <v-btn
              size="small"
              variant="text"
              color="error"
              icon="mdi-delete-outline"
              :title="t('yarj.prefs.deleteRule', '删除规则')"
              @click="removeFilterRule(idx)"
            />
          </div>

          <v-row dense class="align-center">
            <!-- 字段选择 -->
            <v-col cols="12" md="4">
              <div class="text-caption font-weight-medium mb-1">
                {{ t('yarj.prefs.field', '筛选字段 (Field / Metadata Key)') }}
              </div>
              <v-combobox
                v-model="rule.field"
                :items="COMMON_FIELDS"
                item-title="title"
                item-value="value"
                :return-object="false"
                density="compact"
                variant="outlined"
                hide-details
                @update:model-value="emit('change')"
              />
            </v-col>

            <!-- 操作符选择 -->
            <v-col cols="12" md="3">
              <div class="text-caption font-weight-medium mb-1">
                {{ t('yarj.prefs.operator', '运算符 (Operator)') }}
              </div>
              <v-select
                v-model="rule.operator"
                :items="OPERATORS"
                item-title="title"
                item-value="value"
                density="compact"
                variant="outlined"
                hide-details
                @update:model-value="emit('change')"
              />
            </v-col>

            <!-- 目标值输入 -->
            <v-col cols="12" md="5">
              <div class="text-caption font-weight-medium mb-1">
                {{ t('yarj.prefs.targetValue', '目标值 (Value / 列表)') }}
              </div>
              <v-text-field
                v-model="rule.value"
                :disabled="rule.operator === 'is_empty' || rule.operator === 'is_not_empty'"
                density="compact"
                variant="outlined"
                hide-details
                placeholder='例如: ["Document", "Blackboard"] 或逗号分隔'
                @update:model-value="emit('change')"
              />
            </v-col>
          </v-row>

          <!-- 针对 AI 分类的快捷 Chip 勾选栏 -->
          <div
            v-if="
              rule.field.includes('ai_generated.type') &&
              (rule.operator === 'in' || rule.operator === 'not_in')
            "
            class="pt-3"
          >
            <div class="text-caption text-disabled mb-2">
              {{ t('yarj.prefs.quickSelectAi', '快捷点选分类（点击添加到排除/包含集合）：') }}
            </div>
            <div class="d-flex flex-wrap ga-1-5">
              <v-chip
                v-for="typeName in AI_TYPES"
                :key="typeName"
                size="small"
                :variant="
                  parseValuesList(rule.value || '').some(
                    (s) => s.toLowerCase() === typeName.toLowerCase()
                  )
                    ? 'flat'
                    : 'outlined'
                "
                :color="
                  parseValuesList(rule.value || '').some(
                    (s) => s.toLowerCase() === typeName.toLowerCase()
                  )
                    ? rule.operator === 'not_in'
                      ? 'error'
                      : 'primary'
                    : undefined
                "
                class="cursor-pointer filter-type-chip"
                @click="toggleAiTypeInRule(rule, typeName)"
              >
                <v-icon
                  v-if="
                    parseValuesList(rule.value || '').some(
                      (s) => s.toLowerCase() === typeName.toLowerCase()
                    )
                  "
                  size="14"
                  class="mr-1"
                >
                  {{ rule.operator === 'not_in' ? 'mdi-close-circle' : 'mdi-check-circle' }}
                </v-icon>
                {{ typeName }}
              </v-chip>
            </div>
          </div>
        </v-card>
      </div>
    </v-card-text>
  </v-card>
</template>

<style scoped>
.filter-chip {
  height: 22px;
  font-size: 0.72rem;
}

.ga-1-5 {
  gap: 6px;
}

.filter-type-chip {
  transition: all 0.15s ease;
}

.filter-type-chip:hover {
  transform: translateY(-1px);
}
</style>
