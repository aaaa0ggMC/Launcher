/** One-finger dismissal, with direction locking so vertical navigation stays scrollable. */
export class DrawerSwipe {
  private pointers = new Set<number>()
  private gesture: {
    id: number
    x: number
    y: number
    width: number
    time: number
    offset: number
    dragging: boolean
    rejected: boolean
  } | null = null

  down(id: number, x: number, y: number, width: number, time: number): void {
    this.pointers.add(id)
    if (this.pointers.size !== 1) {
      this.gesture = null
      return
    }
    this.gesture = { id, x, y, width, time, offset: 0, dragging: false, rejected: false }
  }

  move(id: number, x: number, y: number): { offset: number; dragging: boolean } | null {
    const g = this.gesture
    if (!g || g.id !== id || g.rejected) return null
    const dx = x - g.x
    const dy = Math.abs(y - g.y)
    if (!g.dragging) {
      if (dy >= 8 && dy >= Math.abs(dx)) g.rejected = true
      else if (dx >= 8) g.rejected = true
      else if (dx <= -8 && -dx > dy * 1.25) g.dragging = true
    }
    g.offset = g.dragging ? Math.max(-g.width, Math.min(0, dx)) : 0
    return { offset: g.offset, dragging: g.dragging }
  }

  end(id: number, time: number, canceled = false): { close: boolean; dragged: boolean } {
    this.pointers.delete(id)
    const g = this.gesture
    if (!g || g.id !== id) return { close: false, dragged: false }
    this.gesture = null
    const distance = -g.offset
    const velocity = distance / Math.max(1, time - g.time)
    return {
      close:
        !canceled &&
        g.dragging &&
        (distance >= Math.min(72, g.width * 0.25) || (distance >= 24 && velocity >= 0.4)),
      dragged: g.dragging
    }
  }

  reset(): void {
    this.gesture = null
    this.pointers.clear()
  }
}
