/** Three-way merge: incoming server state plus edits made since the last known snapshot. */
const absent = Symbol('absent')
type Value = unknown | typeof absent

function same(a: Value, b: Value): boolean {
  return a === b || (a !== absent && b !== absent && JSON.stringify(a) === JSON.stringify(b))
}
function object(value: Value): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function keyed(value: Value): value is { id: string; [key: string]: unknown }[] {
  return Array.isArray(value) && value.every((item) => object(item) && typeof item.id === 'string')
}
function merge(base: Value, local: Value, remote: Value): Value {
  if (same(base, local)) return remote
  if (local === absent || remote === absent) return local
  if (keyed(base) && keyed(local) && keyed(remote)) {
    const b = new Map(base.map((item) => [item.id, item]))
    const l = new Map(local.map((item) => [item.id, item]))
    const r = new Map(remote.map((item) => [item.id, item]))
    const result: unknown[] = []
    for (const id of new Set([...r.keys(), ...l.keys()])) {
      const value = merge(b.get(id) ?? absent, l.get(id) ?? absent, r.get(id) ?? absent)
      if (value !== absent) result.push(value)
    }
    return result
  }
  if (object(base) && object(local) && object(remote)) {
    const result: Record<string, unknown> = {}
    for (const key of new Set([
      ...Object.keys(remote),
      ...Object.keys(local),
      ...Object.keys(base)
    ])) {
      const value = merge(
        Object.hasOwn(base, key) ? base[key] : absent,
        Object.hasOwn(local, key) ? local[key] : absent,
        Object.hasOwn(remote, key) ? remote[key] : absent
      )
      if (value !== absent) result[key] = value
    }
    return result
  }
  return local
}

export function mergeConfigSnapshot<T>(base: T, local: T, remote: T): T {
  return JSON.parse(JSON.stringify(merge(base, local, remote))) as T
}
