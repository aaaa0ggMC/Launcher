<script setup lang="ts">
/**
 * storyteller 插件的输入框扩展：「+」→「故事档案」，浮层里看当前分支的完整设定
 * （世界、角色、线索、剧情摘要）。角色的秘密默认遮住（剧透），点「显示秘密」才露出。
 */
import { computed, inject, onBeforeUnmount, onMounted, ref, toRef } from 'vue'
import type { Ref } from 'vue'
import { useI18n } from '@ui/i18n'
import type { PluginInputContext } from '../../components/plugin-input'
import type { StoryBible } from './bible'

const props = defineProps<{ context: PluginInputContext }>()
const context = toRef(props, 'context')

const lang = inject('cockpit:lang', ref('zh')) as Ref<string>
const { t, te } = useI18n(lang)

const open = ref(false)
const loading = ref(false)
const error = ref('')
const bible = ref<StoryBible | null>(null)
const showSecrets = ref(false)

const narrow = typeof matchMedia === 'function' && matchMedia('(max-width: 720px)').matches
const openThreads = computed(() => bible.value?.threads.filter((x) => x.status === 'open') ?? [])
const resolved = computed(() => bible.value?.threads.filter((x) => x.status === 'resolved') ?? [])

async function show(): Promise<void> {
  open.value = true
  showSecrets.value = false
  error.value = ''
  bible.value = null
  const session = context.value.sessionId.value
  if (!session) return
  loading.value = true
  try {
    bible.value = (await window.cockpit.command('yaya.storyteller-bible', {
      session
    })) as StoryBible | null
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

let dispose: (() => void) | null = null
onMounted(() => {
  dispose = context.value.addAction({
    id: 'story-bible',
    icon: 'mdi-book-account-outline',
    label: t('yaya.story.bible.action', '故事档案'),
    description: t('yaya.story.bible.action_desc', '故事模式的世界、角色与线索'),
    order: 60,
    run: show
  })
})
onBeforeUnmount(() => dispose?.())
</script>

<template>
  <v-dialog v-model="open" :fullscreen="narrow" max-width="720" scrollable>
    <v-card class="yaya-pop story-bible">
      <v-card-title class="d-flex align-center ga-2 pt-4 px-5">
        <v-icon icon="mdi-book-account-outline" color="primary" />
        <span class="text-truncate">{{
          bible?.title || t('yaya.story.bible.title', '故事档案')
        }}</span>
        <v-spacer />
        <v-btn
          icon="mdi-close"
          variant="text"
          size="small"
          :title="t('yaya.cancel', '关闭')"
          :aria-label="t('yaya.cancel', '关闭')"
          @click="open = false"
        />
      </v-card-title>

      <v-card-text class="px-5 pb-5">
        <div v-if="loading" class="d-flex justify-center py-8">
          <v-progress-circular indeterminate color="primary" />
        </div>
        <v-alert v-else-if="error" type="error" variant="tonal">{{ error }}</v-alert>
        <div v-else-if="!bible" class="sb-empty text-medium-emphasis">
          <v-icon icon="mdi-book-open-blank-variant-outline" size="36" class="mb-2" />
          <div>
            {{
              t(
                'yaya.story.bible.empty',
                '这个对话的当前分支还没有故事档案：在工作流菜单里选「故事模式」，然后说出你想要的故事。'
              )
            }}
          </div>
        </div>
        <template v-else>
          <div class="sb-meta text-medium-emphasis">
            <span v-if="bible.genre">{{ bible.genre }}</span>
            <span>{{
              te(
                'yaya.story.card.position',
                { chapter: String(bible.chapter), turn: String(bible.turn) },
                '第 {chapter} 章 · 第 {turn} 轮'
              )
            }}</span>
            <span v-if="bible.location">📍 {{ bible.location }}</span>
          </div>
          <p v-if="bible.premise" class="sb-premise">{{ bible.premise }}</p>

          <section v-if="bible.characters.length">
            <div class="sb-h">
              <span>{{ t('yaya.story.bible.characters', '角色') }}</span>
              <v-spacer />
              <v-btn
                variant="text"
                :prepend-icon="showSecrets ? 'mdi-eye-off-outline' : 'mdi-eye-outline'"
                @click="showSecrets = !showSecrets"
              >
                {{
                  showSecrets
                    ? t('yaya.story.bible.hide_secrets', '隐藏秘密')
                    : t('yaya.story.bible.show_secrets', '显示秘密（剧透）')
                }}
              </v-btn>
            </div>
            <div class="sb-people">
              <div v-for="c in bible.characters" :key="c.name" class="sb-person">
                <div class="sb-person-head">
                  <span class="font-weight-bold">{{ c.name }}</span>
                  <span v-if="c.role" class="sb-role">{{ c.role }}</span>
                </div>
                <div v-if="c.traits" class="sb-line">{{ c.traits }}</div>
                <div v-if="c.goal" class="sb-line">
                  <span class="sb-k">{{ t('yaya.story.bible.goal', '目标') }}</span
                  >{{ c.goal }}
                </div>
                <div v-if="c.status" class="sb-line">
                  <span class="sb-k">{{ t('yaya.story.bible.status', '状态') }}</span
                  >{{ c.status }}
                </div>
                <div v-if="c.relations" class="sb-line">
                  <span class="sb-k">{{ t('yaya.story.bible.relations', '关系') }}</span
                  >{{ c.relations }}
                </div>
                <div v-if="showSecrets && c.secret" class="sb-line sb-secret">
                  <span class="sb-k">{{ t('yaya.story.bible.secret', '秘密') }}</span
                  >{{ c.secret }}
                </div>
              </div>
            </div>
          </section>

          <section v-if="bible.threads.length">
            <div class="sb-h">{{ t('yaya.story.bible.threads', '线索') }}</div>
            <ul class="sb-list">
              <li v-for="th in openThreads" :key="th.id">
                <v-icon icon="mdi-circle-outline" size="14" class="mr-2" />{{ th.text }}
              </li>
              <li v-for="th in resolved" :key="th.id" class="sb-done">
                <v-icon icon="mdi-check-circle-outline" size="14" class="mr-2" />{{ th.text }}
              </li>
            </ul>
          </section>

          <section v-if="bible.world.length">
            <div class="sb-h">{{ t('yaya.story.bible.world', '世界设定') }}</div>
            <ul class="sb-list">
              <li v-for="(w, i) in bible.world" :key="i">{{ w }}</li>
            </ul>
          </section>

          <section v-if="bible.timeline.length">
            <div class="sb-h">{{ t('yaya.story.bible.timeline', '剧情摘要') }}</div>
            <ol class="sb-list sb-timeline">
              <li v-for="(s, i) in bible.timeline" :key="i">{{ s }}</li>
            </ol>
          </section>
        </template>
      </v-card-text>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.sb-empty {
  text-align: center;
  padding: 32px 8px;
  display: flex;
  flex-direction: column;
  align-items: center;
}
.sb-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  font-size: 0.8125rem;
}
.sb-premise {
  margin: 10px 0 4px;
  line-height: 1.6;
}
section {
  margin-top: 18px;
}
.sb-h {
  display: flex;
  align-items: center;
  font-weight: 600;
  font-size: 0.9375rem;
  margin-bottom: 8px;
  min-height: 36px;
}
.sb-people {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 10px;
}
.sb-person {
  padding: 10px 12px;
  border-radius: 12px;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  background: rgba(var(--v-theme-on-surface), 0.03);
  font-size: 0.8125rem;
  min-width: 0;
}
.sb-person-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
  font-size: 0.875rem;
}
.sb-role {
  padding: 0 8px;
  border-radius: 10px;
  font-size: 0.6875rem;
  background: rgba(var(--v-theme-primary), 0.14);
  color: rgb(var(--v-theme-primary));
}
.sb-line {
  margin-top: 3px;
  overflow-wrap: anywhere;
  line-height: 1.5;
}
.sb-k {
  color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  margin-right: 6px;
}
.sb-secret {
  color: rgb(var(--v-theme-error));
}
.sb-list {
  margin: 0;
  padding-left: 4px;
  list-style: none;
  font-size: 0.875rem;
  line-height: 1.7;
}
.sb-timeline {
  list-style: decimal;
  padding-left: 22px;
}
.sb-done {
  opacity: 0.6;
  text-decoration: line-through;
}
</style>
