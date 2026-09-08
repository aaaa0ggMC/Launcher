import type { CommandSpec } from '../../../main/process/commands/types'
import { getBroadcast } from '../../../main/process/broadcast'
import {
  listMetadataSlots,
  getMetadataSlotEntries,
  toggleMetadataSlot,
  toggleMetadataSlotItem,
  toggleMetadataSlotAllItems,
  createMetadataSlot,
  deleteMetadataSlot,
  setActiveWriteSlot,
  setBiliDefaultSlot
} from '../services/metadata-slots'
import { recomputeActiveLibraryMetadata, scanMusicFiles } from '../services/library'
import { loadAidjConfig } from '../services/config'
import { BiliClient, BiliCredential, parseAllBvids, getVideoDetail } from '../bili_api'
import type { SongMeta } from '../types'
import { state, log } from './shared'

export interface ResolvedBiliItem {
  id: string
  bvid: string
  aid: number
  cid: number
  page: number
  partTitle: string
  isMultiPart: boolean
  title: string
  author: string
  duration: number
  pic: string
  tags: string[]
}

export async function syncSlotsAndBroadcast(recomputed?: Map<string, SongMeta>): Promise<{
  activeCount: number
  libraryTracks: number
}> {
  const metadata = recomputed ?? (await recomputeActiveLibraryMetadata())
  state.metadata = metadata
  if (state.session) {
    state.session.metadata = metadata
  }

  if (!state.musicPaths) {
    try {
      const config = await loadAidjConfig()
      state.musicPaths = await scanMusicFiles(config?.music_folders ?? [])
    } catch {
      /* ignore */
    }
  }

  if (state.session && state.musicPaths) {
    state.session.musicPaths = state.musicPaths
  }

  const libraryTracks =
    state.musicPaths && state.musicPaths.size > 0
      ? [...metadata.keys()].filter((k) => state.musicPaths!.has(k)).length
      : metadata.size

  try {
    const emit = getBroadcast()
    emit('cockpit:aidj-slots-changed', {
      tracks: libraryTracks,
      totalActiveSongs: metadata.size
    })
  } catch (e) {
    log.warn('Failed to broadcast aidj-slots-changed', { error: String(e) })
  }

  return { activeCount: metadata.size, libraryTracks }
}

export const metadataSlotsCommands: CommandSpec[] = [
  {
    name: 'aidj.metadata-slots-list',
    description: '列出所有元数据槽位及激活状态',
    usage: 'aidj.metadata-slots-list',
    run: async () => {
      const res = await listMetadataSlots()
      return { ok: true, ...res }
    }
  },
  {
    name: 'aidj.metadata-slots-entries',
    description: '获取指定槽位中的所有歌曲条目',
    usage: 'aidj.metadata-slots-entries --slot <id> [--filter <keyword>]',
    run: async (ctx) => {
      const slotId = (ctx.named.slot as string) || (ctx.named.id as string) || 'default'
      const filter = (ctx.named.filter as string) || ''
      const res = await getMetadataSlotEntries(slotId, filter)
      return { ok: true, ...res }
    }
  },
  {
    name: 'aidj.metadata-slots-toggle',
    description: '切换槽位或槽位内单曲的启用状态并即时重算生效曲库',
    usage: 'aidj.metadata-slots-toggle --slot <id> [--song <name>] [--enabled <bool>]',
    run: async (ctx) => {
      const slotId = (ctx.named.slot as string) || (ctx.named.id as string)
      if (!slotId) return { ok: false, error: '缺少 slot 参数' }

      const songName = (ctx.named.song as string) || ''
      const enabledParam =
        ctx.named.enabled !== undefined ? String(ctx.named.enabled) === 'true' : undefined

      let result
      if (songName) {
        result = await toggleMetadataSlotItem(slotId, songName, enabledParam ?? true)
      } else {
        result = await toggleMetadataSlot(slotId, enabledParam)
      }

      await syncSlotsAndBroadcast()
      return { ok: true, ...result }
    }
  },
  {
    name: 'aidj.metadata-slots-toggle-all',
    description: '全选或全不选槽位内的所有条目并即时重算',
    usage: 'aidj.metadata-slots-toggle-all --slot <id> --enable-all <bool>',
    run: async (ctx) => {
      const slotId = (ctx.named.slot as string) || (ctx.named.id as string)
      if (!slotId) return { ok: false, error: '缺少 slot 参数' }

      const enableAll = String(ctx.named['enable-all'] ?? ctx.named.enableAll ?? 'true') === 'true'
      const result = await toggleMetadataSlotAllItems(slotId, enableAll)

      await syncSlotsAndBroadcast()
      return result
    }
  },
  {
    name: 'aidj.metadata-slots-create',
    description: '创建新的元数据槽位集合',
    usage: 'aidj.metadata-slots-create --name <name>',
    run: async (ctx) => {
      const name = (ctx.named.name as string) || ctx.positional.join(' ')
      if (!name) return { ok: false, error: '槽位名称不能为空' }
      const res = await createMetadataSlot(name)
      if (res.ok) {
        await syncSlotsAndBroadcast()
      }
      return res
    }
  },
  {
    name: 'aidj.metadata-slots-delete',
    description: '删除元数据槽位文件',
    usage: 'aidj.metadata-slots-delete --slot <id>',
    run: async (ctx) => {
      const slotId = (ctx.named.slot as string) || (ctx.named.id as string)
      if (!slotId) return { ok: false, error: '缺少 slot 参数' }
      const res = await deleteMetadataSlot(slotId)
      if (res.ok) {
        await syncSlotsAndBroadcast()
      }
      return res
    }
  },
  {
    name: 'aidj.metadata-slots-set-write',
    description: '设置元数据同步与构建的写入目标槽位',
    usage: 'aidj.metadata-slots-set-write --slot <id>',
    run: async (ctx) => {
      const slotId = (ctx.named.slot as string) || (ctx.named.id as string) || 'default'
      const res = await setActiveWriteSlot(slotId)
      await syncSlotsAndBroadcast()
      return res
    }
  },
  {
    name: 'aidj.metadata-slots-set-bili-default',
    description: '设置 Bilibili 视频下载的默认元数据写入槽位',
    usage: 'aidj.metadata-slots-set-bili-default --slot <id>',
    run: async (ctx) => {
      const slotId =
        (ctx.named.slot as string) || (ctx.named.id as string) || 'Bilibili-Current.metadata'
      const res = await setBiliDefaultSlot(slotId)
      await syncSlotsAndBroadcast()
      return res
    }
  },
  {
    name: 'aidj.bili-resolve',
    description: '从输入文本中解析所有 BVID/AVID 并展开分P视频信息',
    usage: 'aidj.bili-resolve --input <text>',
    run: async (ctx) => {
      const input = (ctx.named.input as string) || ctx.positional.join(' ')
      const bvids = parseAllBvids(input)
      if (bvids.length === 0) {
        return { ok: false, error: '未在输入内容中解析出有效的 BV 号或 AV 号' }
      }

      const config = await loadAidjConfig()
      const { credential } = BiliCredential.resolve(config?.preferences?.bili_credential_path)
      const client = new BiliClient({ credential })

      const items: ResolvedBiliItem[] = []
      const errors: string[] = []

      for (const bvid of bvids) {
        try {
          const detail = await getVideoDetail(client, bvid)
          const pages = detail.pages || []

          if (pages.length > 1) {
            // Multi-part video: decompose each P into an item
            for (const page of pages) {
              items.push({
                id: `${bvid}_${page.cid}`,
                bvid,
                aid: detail.aid,
                cid: page.cid,
                page: page.page,
                partTitle: page.part,
                isMultiPart: true,
                title: detail.title,
                author: detail.author,
                duration: page.duration || detail.duration,
                pic: detail.pic,
                tags: detail.tags
              })
            }
          } else {
            // Single part video
            items.push({
              id: `${bvid}_${detail.cid}`,
              bvid,
              aid: detail.aid,
              cid: detail.cid,
              page: 1,
              partTitle: '',
              isMultiPart: false,
              title: detail.title,
              author: detail.author,
              duration: detail.duration,
              pic: detail.pic,
              tags: detail.tags
            })
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          errors.push(`${bvid}: ${msg}`)
        }
      }

      if (items.length === 0 && errors.length > 0) {
        return { ok: false, error: `解析失败: ${errors.join('; ')}` }
      }

      return {
        ok: true,
        items,
        totalBvids: bvids.length,
        errors: errors.length > 0 ? errors : undefined
      }
    }
  }
]
