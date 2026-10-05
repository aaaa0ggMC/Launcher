/**
 * 状态栏紧凑模式：按实测宽度决定一行能放下前几个标签，其余收进「+N」。
 * 纯函数，见 status-fit.test.ts。
 *
 * @param widths   每个标签的实测宽度（按显示顺序）
 * @param available 一行可用宽度
 * @param gap      标签间距
 * @param moreWidth 「+N」标签的宽度（始终显示，用来打开弹层）
 */
export function fitStatusCount(
  widths: number[],
  available: number,
  gap: number,
  moreWidth: number
): number {
  let used = moreWidth
  let n = 0
  for (const w of widths) {
    const next = used + gap + w
    if (next > available) break
    used = next
    n++
  }
  return n
}
