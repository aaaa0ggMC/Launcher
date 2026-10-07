# 输入框插件（composer input extensions）SDK

> 状态：设计 + 实现（2026-10-05）。
> 契约在 `src/abilities/yaya/components/plugin-input.ts`，注册表是 `components/plugin-ui-registry.ts`
> 的 `inputExtensions`，参考实现是 `plugins/mention/`（`@` 点名）。

---

## 一、它解决什么问题

输入框原来把「@ 点名」这类功能写死在 `ChatInputBox.vue` 里：草稿、焦点、发送、附件、提名搅在一起，
想再加一个 `/命令` 面板就得再改一遍宿主。现在输入框只保留**文本 / 焦点 / 发送 / 会话**四件事，
其余能力以插件扩展的形式注入：**插件拥有自己的界面与状态**，禁用插件 = 组件被卸载 = 界面与状态一起消失。

## 二、三个契约

| 契约                 | 方向        | 内容                                                                                                                                                        |
| -------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PluginInputProps`   | 宿主 → 插件 | 只有一个 `context`                                                                                                                                          |
| `PluginInputContext` | 宿主提供    | `draft`（草稿 Ref）、`sessionId`、`toolbarTarget`（工具栏容器 Ref）、`focus()`、`selection()`、`replaceRange(start,end,text)`、`register(hooks) -> dispose` |
| `PluginInputHooks`   | 插件提供    | `triggers`、`onTrigger(match\|null)`、`onKeyDown(e) -> boolean`、`collect() -> { mentions? }`、`hasContent()`、`reset()`                                    |

宿主在每次按键 / 点击 / 抬起时用 `matchInputTrigger(draft, caret, triggers)` 算匹配，把结果送给
`onTrigger`；发送前依次问 `hasContent()` 与 `collect()`；发送后、切换会话时调 `reset()`。

## 三、文本触发（triggers）

```ts
const TRIGGERS = [{ prefix: '@', maxQueryLength: 32 }, { prefix: '/skill' }]
```

- `prefix` 是**字面**前缀：`@`、`/skill`、`[` 都行（不需要转义，不写正则）。
- `boundary` 默认 `true`：只匹配行首或空白之后——所以邮箱 `a@b.com`、`x@y` 不会误触发。
- `maxQueryLength` 默认 64：查询超过这个长度就不再算触发（防止长文里偶然出现的 `@` 一直弹窗）。
- 匹配结果 `{ prefix, query, start, end }`：`start` 是前缀起点，**`end` 永远等于触发那一刻的光标**。

**删触发文本**只能走 `context.replaceRange`，而且要带校验：触发到确认之间用户可能继续输入、改了这段文字、
把光标移回区间中间，这时宁可不删，也不能吃掉用户的新文字（见 `plugins/mention/select.ts` 的
`validTriggerRange`）。`replaceRange` 会自己把光标恢复到你指定的位置，后面的文字原样保留。

## 四、键盘（onKeyDown）

返回 `true` = 事件被吞掉，宿主不再处理（因此也不会发送）。建议接管：`Enter` / `Tab` = 选当前项、
`Escape` = 关闭、`↑` / `↓` = 移动高亮。

```ts
function handleKey(e: KeyboardEvent): boolean {
  if (!open.value) return false
  // 输入法组合期一律不吞：Enter / 方向键 / Tab 都要留给候选字上屏，否则会误选插件
  if (e.isComposing || e.keyCode === 229) return false
  ...
}
```

**IME 纪律**：组合期（`e.isComposing`，旧内核看 `keyCode === 229`）什么键都不吞。否则中文输入时
敲回车确认候选字，会顺手把插件也「选」了。宿主自己的 Enter 发送同样看 `isComposing`，两边一致。

## 五、工具栏（toolbarTarget + Teleport）

宿主渲染一个空容器（`.plugin-input-tools`），**模板 ref 在子组件挂载之后才赋值**，所以要先等它出现：

```vue
<Teleport v-if="context.toolbarTarget.value" :to="context.toolbarTarget.value">
  <v-btn icon="mdi-at" @mousedown.prevent @click="openManual" />
</Teleport>
```

- 必须 `v-if` 守卫：目标还是 `null` 时 Teleport 会告警。
- 按钮要 `@mousedown.preventDefault`（或宿主同款 `keepFocus`），否则点一下就把焦点从输入框抢走，
  手机上键盘一收一起，页面重排后按钮从手指下面滑走。
- 工具栏按钮打开的是**手动模式**：弹窗里要有一个可聚焦的搜索框（键入即筛选），不依赖光标位置；
  关闭时用 `context.focus()` 把焦点还给输入框。

## 六、状态与生命周期

- **挂载注册、卸载反注册**：`const dispose = context.register(hooks)`，`onBeforeUnmount` 里 `dispose()`。
  一个组件实例只注册一次（宿主按组件实例 key 存 hooks）。
- **禁用即消失**：`inputExtensions` 只包含后端确认已启用的插件，插件被禁用时组件直接卸载——
  不需要监听任何禁用事件，把清理写进 `onBeforeUnmount` 即可。
- **跨会话不能串**：宿主在切换会话与发送后都会调 `reset()`，插件要在那时清空自己的一切
  （已选项、弹窗、在途请求、防抖定时器）。自己再 `watch(sessionId)` 兜一层更稳。
- **异步结果立即作废**：请求带一个自增的 `gen`，查询变化、关闭、重置、卸载、切换会话时 `gen += 1`，
  回来发现对不上就丢。不要只是「再发一次覆盖」——关闭后回来的旧结果会把弹窗又撑开。

## 七、权限边界

| 归宿主                                 | 归插件                                           |
| -------------------------------------- | ------------------------------------------------ |
| 草稿内容、焦点、会话 id、什么时候发送  | 自己的弹窗 / 标签 / 候选请求 / 键盘策略 / 选中项 |
| 注册表的中间件（隐私、审批、命令分发） | 组件的本地状态与定时器                           |

插件**不许**：

- 直接操作 DOM 抢宿主输入框的焦点（手动模式弹完要还回去）；
- 绕过 `replaceRange` 改草稿，或用正则去猜光标位置；
- 自己开第二条发送通道（发消息永远走宿主的 `send`）；
- 在 `collect()` 里替用户编造内容：只回自己真正收集到的（如点名列表）。

功能本身该有的权限照旧走命令：点名候选来自 `yaya.mention-candidates`（实现 `services/plugins/mention.ts`），
插件只做界面，不在渲染端复制后端规则。

## 八、接入步骤

1. **后端插件** `plugins/<id>/index.ts`：`YayaPlugin`（`id` / `kind: 'builtin'` / `label` + `labelKey` /
   `description` + `descriptionKey` / `icon` / `defaultEnabled` / `tools`）。`commands.ts` 的 glob
   `./plugins/*/index.ts` 自动注册，不用改任何注册表。
2. **界面注册** `plugins/<id>/ui.ts`：

   ```ts
   import { definePluginUi } from '../../components/plugin-ui'
   export default definePluginUi({
     pluginId: '<id>',
     inputExtension: () => import('./MentionInput.vue')
   })
   ```

3. **组件**：`defineProps<{ context: PluginInputContext }>()` → `onMounted` 里 `register`，
   `onBeforeUnmount` 里 `invalidate + dispose`。
4. **纯逻辑**抽成 `plugins/<id>/select.ts`（候选过滤、环绕索引、区间校验），配
   `select.test.ts` 用 `node:test` 离线跑（`pnpm test`），不碰 DOM / 命令 / 配置。
5. **翻译**：界面字符串走 `useI18n` 的 `t(key, 兜底)`，键写进插件自己的
   `plugins/<id>/translations/zh.json` 与 `en-US.json`（键名带 `yaya.<插件id>.` 前缀；
   前端与主进程都会自动合并，不要加进 yaya 的全局翻译）。

## 九、最小可运行示例（点名插件的骨架）

```ts
// plugins/demo/index.ts
import type { YayaPlugin } from '../../services/plugins/types'
const plugin: YayaPlugin = {
  id: 'demo',
  kind: 'builtin',
  label: '演示',
  labelKey: 'yaya.plugin.demo.label',
  description: '输入框扩展示例',
  descriptionKey: 'yaya.plugin.demo.desc',
  icon: 'mdi-at',
  defaultEnabled: true,
  tools: () => []
}
export default plugin
```

```vue
<!-- plugins/demo/DemoInput.vue -->
<script setup lang="ts">
import { inject, onBeforeUnmount, onMounted, ref, toRef } from 'vue'
import type { PluginInputContext } from '../../components/plugin-input'

const props = defineProps<{ context: PluginInputContext }>()
const context = toRef(props, 'context')
const lang = inject('cockpit:lang', ref('zh'))
const open = ref(false)

onMounted(() => {
  context.value.register({
    triggers: [{ prefix: '/demo', maxQueryLength: 32 }],
    onTrigger: (m) => (open.value = !!m),
    onKeyDown: (e) => {
      if (!open.value || e.isComposing) return false
      if (e.key === 'Escape') {
        open.value = false
        return true
      }
      return false
    },
    collect: () => ({ mentions: ['demo'] }),
    hasContent: () => open.value,
    reset: () => (open.value = false)
  })
})
onBeforeUnmount(() => (open.value = false))
</script>

<template>
  <Teleport v-if="context.toolbarTarget.value" :to="context.toolbarTarget.value">
    <button type="button" @mousedown.prevent @click="open = !open">/demo</button>
  </Teleport>
  <div v-if="open" class="demo-pop">演示弹窗（插件自己的界面）</div>
</template>
```

`register` 的返回值就是反注册函数，忘记调用 = 卸载后 hooks 还挂在宿主上（点了没反应、报错找不到组件）。
