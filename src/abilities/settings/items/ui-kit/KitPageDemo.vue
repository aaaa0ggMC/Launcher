<script setup lang="ts">
/**
 * 画廊 · KitPage —— 三种滚动模式并排。
 * app / canvas 用 absolute inset:0 铺满宿主，所以每个示例都套一个 position:relative
 * 的定高盒子（这也正是真实页面里宿主给的角色）。
 */
import { inject, ref } from 'vue'
import type { Ref } from 'vue'
import { KitPage, KitSection } from '@ui/kit'
import { translate } from '@ui/i18n'
import KitDemoCard from './KitDemoCard.vue'

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)

const lines = Array.from({ length: 24 }, (_, i) => i + 1)
</script>

<template>
  <KitDemoCard
    :title="t('kit.gallery.page.title', 'KitPage · 页面外壳（三种滚动模式）')"
    import-path="import { KitPage, KitSection } from '@ui/kit'"
    :use="
      t(
        'kit.gallery.page.use',
        '每个能力页面的根节点。document=长表单整页滚；app=固定顶/底栏+中间滚；canvas=全幅页面（内部区域各自滚，内容超高外壳才滚）。'
      )
    "
    :avoid="
      t(
        'kit.gallery.page.avoid',
        '不要在手写 calc(100vh - Npx)——appbar 实测高度会变，absolute inset:0 才不吃魔数。'
      )
    "
  >
    <div class="kit-demo-grid">
      <!-- document：正常文档流 -->
      <div class="kit-demo-mode">
        <div class="kit-demo-mode__head text-subtitle-2">document</div>
        <div class="kit-demo-mode__scroll">
          <KitPage mode="document">
            <KitSection
              :title="t('kit.gallery.page.docTitle', '长表单')"
              icon="mdi-format-list-bulleted"
            >
              <div v-for="n in lines" :key="n" class="kit-demo-line">
                {{ n }}. {{ t('kit.gallery.page.row', '设置项') }}
              </div>
            </KitSection>
          </KitPage>
        </div>
      </div>

      <!-- app：页面级零滚动，内部区域各自滚 -->
      <div class="kit-demo-mode">
        <div class="kit-demo-mode__head text-subtitle-2">app</div>
        <div class="kit-demo-mode__app">
          <KitPage mode="app">
            <KitSection
              :title="t('kit.gallery.page.fixedHead', '固定顶栏')"
              icon="mdi-page-layout-header"
            >
              <span class="text-body-2">{{
                t('kit.gallery.page.fixedHeadDesc', '不滚动的头部')
              }}</span>
            </KitSection>
            <KitSection
              scroll
              :title="t('kit.gallery.page.scrollBody', '可滚内容区')"
              icon="mdi-format-list-bulleted"
            >
              <div v-for="n in lines" :key="n" class="kit-demo-line">
                {{ n }}. {{ t('kit.gallery.page.row', '设置项') }}
              </div>
            </KitSection>
            <KitSection
              :title="t('kit.gallery.page.fixedFoot', '固定底栏')"
              icon="mdi-page-layout-footer"
            >
              <span class="text-body-2">{{
                t('kit.gallery.page.fixedFootDesc', '输入条 / 操作区')
              }}</span>
            </KitSection>
          </KitPage>
        </div>
      </div>

      <!-- canvas：两个滚动条都在 -->
      <div class="kit-demo-mode">
        <div class="kit-demo-mode__head text-subtitle-2">canvas</div>
        <div class="kit-demo-mode__app">
          <KitPage mode="canvas">
            <KitSection
              :title="t('kit.gallery.page.canvasTitle', '全幅画布')"
              icon="mdi-vector-square"
            >
              <div class="kit-demo-canvas">
                {{ t('kit.gallery.page.canvasBody', 'ft / dashboard / 地图类页面') }}
              </div>
            </KitSection>
            <KitSection
              scroll
              :title="t('kit.gallery.page.panel', '浮层面板（内滚）')"
              icon="mdi-format-list-bulleted"
            >
              <div v-for="n in lines" :key="n" class="kit-demo-line">
                {{ n }}. {{ t('kit.gallery.page.row', '设置项') }}
              </div>
            </KitSection>
          </KitPage>
        </div>
      </div>
    </div>
  </KitDemoCard>
</template>

<style scoped>
.kit-demo-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 12px;
}

.kit-demo-mode {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.kit-demo-mode__head {
  padding-inline: 4px;
  opacity: 0.8;
}

/* document：外壳自己滚（给个限高才能看出滚动） */
.kit-demo-mode__scroll {
  max-height: 220px;
  overflow-y: auto;
  border-radius: 8px;
  border: 1px solid rgba(var(--v-theme-on-surface), 0.1);
}

/* app / canvas：宿主角色——position:relative + 定高，KitPage 才能 inset:0 铺满 */
.kit-demo-mode__app {
  position: relative;
  height: 220px;
  border-radius: 8px;
  border: 1px solid rgba(var(--v-theme-on-surface), 0.1);
  overflow: hidden;
}

.kit-demo-line {
  padding: 2px 0;
  font-size: 0.8125rem;
  opacity: 0.75;
}

.kit-demo-canvas {
  display: grid;
  place-items: center;
  min-height: 72px;
  border-radius: 8px;
  font-size: 0.8125rem;
  background: repeating-linear-gradient(
    45deg,
    rgba(var(--v-theme-primary), 0.08) 0 10px,
    transparent 10px 20px
  );
}
</style>
