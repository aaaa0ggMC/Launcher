/**
 * Netease hot-comment fetch — adapted from NeteaseCloudMusicApi
 * module/comment.js (MIT, Binaryify). Used to ground the AI metadata review in
 * real listener sentiment instead of pure hallucination. See ./LICENSE.
 */
import { ncmRequest } from './request'

export interface NcmHotComment {
  nickname: string
  content: string
  likes: number
}

interface RawComment {
  user?: { nickname?: string }
  content?: string
  likedCount?: number
}

export async function ncmComments(id: number, limit = 10): Promise<NcmHotComment[]> {
  const body = await ncmRequest(
    'POST',
    `https://music.163.com/api/v1/resource/comments/R_SO_4_${id}`,
    { rid: id, limit, offset: 0, beforeTime: 0 },
    { crypto: 'weapi' }
  )
  const hot = (body as { hotComments?: RawComment[] }).hotComments ?? []
  return hot.slice(0, limit).map((c) => ({
    nickname: c.user?.nickname ?? '',
    content: c.content ?? '',
    likes: c.likedCount ?? 0
  }))
}
