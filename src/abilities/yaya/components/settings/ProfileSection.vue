<script setup lang="ts">
/**
 * 设置 → 助手 → 形象：你的名字 / 头像、助手头像、每条回答显示的名字，以及它们对 AI 是否可见。
 * 头像在这里缩成 192px 的 data URL 存进配置（不经过宿主文件系统，网页版同样可用）。
 */
import { useI18n } from '@ui/i18n'
import { computed, inject, ref } from 'vue'
import type { Ref } from 'vue'
import type { YayaConfig, YayaProfile } from '../../types'
import { modelMonogram } from '../../profile'
import AvatarBadge from '../AvatarBadge.vue'

defineOptions({ name: 'cockpit-yaya-settings-profile' })
/* eslint-disable vue/no-mutating-props -- 与其他设置分区一样直接改外壳持有的配置对象 */

const props = defineProps<{
  config: YayaConfig
  /** 只显示一半：user = 你的名字 / 头像；assistant = 助手头像 / 署名（某个助手的基本设置页） */
  part?: 'user' | 'assistant'
}>()

const lang = inject('cockpit:lang', ref('zh')) as Ref<string>
const { t } = useI18n(lang)

// 老配置可能没有 profile：先补一个空对象，之后直接改它的字段
if (!props.config.profile) props.config.profile = {}
const profile = computed<YayaProfile>(() => props.config.profile ?? {})

const AVATAR_PX = 192
const error = ref('')
const userInput = ref<HTMLInputElement | null>(null)
const assistantInput = ref<HTMLInputElement | null>(null)

/** 读图片 → 居中裁成正方形 → 192px webp（不支持就 png） */
async function toAvatar(file: File): Promise<string> {
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    const side = Math.min(img.naturalWidth, img.naturalHeight)
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = AVATAR_PX
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('canvas')
    ctx.drawImage(
      img,
      (img.naturalWidth - side) / 2,
      (img.naturalHeight - side) / 2,
      side,
      side,
      0,
      0,
      AVATAR_PX,
      AVATAR_PX
    )
    const webp = canvas.toDataURL('image/webp', 0.85)
    return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/png')
  } finally {
    URL.revokeObjectURL(url)
  }
}

async function onPick(ev: Event, field: 'userAvatar' | 'assistantAvatar'): Promise<void> {
  const input = ev.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  error.value = ''
  try {
    profile.value[field] = await toAvatar(file)
    if (field === 'assistantAvatar') profile.value.assistantAvatarMode = 'custom'
  } catch {
    error.value = t('yaya.profile.bad_image', '这张图片读不出来，换一张试试')
  }
}

const avatarModes = computed(() => [
  { value: 'default', title: t('yaya.profile.avatar_default', '默认图标') },
  { value: 'custom', title: t('yaya.profile.avatar_custom', '自定义图片') },
  { value: 'model', title: t('yaya.profile.avatar_model', '按模型生成') }
])
const labelModes = computed(() => [
  { value: 'name', title: t('yaya.profile.label_name', '助手名称') },
  { value: 'model', title: t('yaya.profile.label_model', '这条回答用的模型') }
])

const assistantPreview = computed(() => ({
  image: profile.value.assistantAvatarMode === 'custom' ? profile.value.assistantAvatar || '' : '',
  monogram:
    profile.value.assistantAvatarMode === 'model'
      ? modelMonogram(props.config.activeModel || 'model')
      : null
}))
</script>

<template>
  <div class="d-flex flex-column ga-4">
    <div v-if="!part" class="text-subtitle-2">{{ t('yaya.profile.title', '形象') }}</div>

    <template v-if="part !== 'assistant'">
      <div class="profile-row">
        <AvatarBadge :image="profile.userAvatar" icon="mdi-account" :size="48" />
        <v-text-field
          v-model="profile.userName"
          class="flex-grow-1"
          :label="t('yaya.profile.user_name', '你的名字')"
          :placeholder="t('yaya.profile.user_name_placeholder', '不填就不显示')"
          maxlength="32"
          variant="outlined"
          hide-details
        />
      </div>
      <div class="d-flex flex-wrap ga-2">
        <v-btn variant="tonal" prepend-icon="mdi-image-outline" @click="userInput?.click()">
          {{ t('yaya.profile.pick_user_avatar', '选择你的头像') }}
        </v-btn>
        <v-btn v-if="profile.userAvatar" variant="text" @click="profile.userAvatar = ''">
          {{ t('yaya.profile.remove_avatar', '移除头像') }}
        </v-btn>
        <input
          ref="userInput"
          type="file"
          accept="image/*"
          hidden
          @change="(e) => onPick(e, 'userAvatar')"
        />
      </div>
      <v-switch
        :model-value="profile.userNameVisible !== false"
        color="primary"
        hide-details
        inset
        :label="t('yaya.profile.user_name_visible', 'AI 知道你的名字')"
        @update:model-value="(v) => (profile.userNameVisible = !!v)"
      />
      <v-switch
        :model-value="profile.userAvatarVisible === true"
        color="primary"
        inset
        :label="t('yaya.profile.user_avatar_visible', 'AI 能看到你的头像')"
        :hint="
          t(
            'yaya.profile.user_avatar_visible_hint',
            '作为图片随对话的第一条消息发给模型，需要模型支持图片'
          )
        "
        persistent-hint
        @update:model-value="(v) => (profile.userAvatarVisible = !!v)"
      />
    </template>

    <v-divider v-if="!part" />

    <template v-if="part !== 'user'">
      <div class="profile-row">
        <AvatarBadge
          :image="assistantPreview.image"
          :monogram="assistantPreview.monogram"
          :size="48"
        />
        <v-select
          :model-value="profile.assistantAvatarMode ?? 'default'"
          class="flex-grow-1"
          :items="avatarModes"
          :label="t('yaya.profile.assistant_avatar', '助手头像')"
          variant="outlined"
          hide-details
          @update:model-value="(v) => (profile.assistantAvatarMode = v)"
        />
      </div>
      <div v-if="profile.assistantAvatarMode === 'custom'" class="d-flex flex-wrap ga-2">
        <v-btn variant="tonal" prepend-icon="mdi-image-outline" @click="assistantInput?.click()">
          {{ t('yaya.profile.pick_assistant_avatar', '选择助手头像') }}
        </v-btn>
        <input
          ref="assistantInput"
          type="file"
          accept="image/*"
          hidden
          @change="(e) => onPick(e, 'assistantAvatar')"
        />
      </div>
      <v-select
        :model-value="profile.assistantLabel ?? 'name'"
        :items="labelModes"
        :label="t('yaya.profile.assistant_label', '每条回答上显示')"
        variant="outlined"
        hide-details
        @update:model-value="(v) => (profile.assistantLabel = v)"
      />
      <v-switch
        :model-value="profile.assistantNameVisible !== false"
        color="primary"
        inset
        :label="t('yaya.profile.assistant_name_visible', 'AI 知道自己的名字')"
        :hint="
          t(
            'yaya.profile.assistant_name_visible_hint',
            '关掉后系统提示词里的 {name} 换成中性的称呼'
          )
        "
        persistent-hint
        @update:model-value="(v) => (profile.assistantNameVisible = !!v)"
      />
    </template>
    <div v-if="error" class="text-caption text-error">{{ error }}</div>
  </div>
</template>

<style scoped>
.profile-row {
  display: flex;
  align-items: center;
  gap: 16px;
  min-width: 0;
}
</style>
