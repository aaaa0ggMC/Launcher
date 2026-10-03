/**
 * Short, stable track IDs (`#k3f9`) for the agent loop — the model passes IDs
 * instead of re-typing long keys, so picks resolve exactly (no fuzzy match).
 * Deterministic for a given library: keys are sorted, hashed (FNV-1a) and
 * collisions linearly probed.
 */

export interface IdIndex {
  /** `#xxxx` for a library key. */
  idOf: (key: string) => string
  /** Library key for `#xxxx` / `xxxx`, or null. */
  keyOf: (id: string) => string | null
}

const ID_RE = /^#?([0-9a-z]{4})$/i
const SPACE = 36 ** 4

function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}

export function buildIdIndex(keys: Iterable<string>): IdIndex {
  const toId = new Map<string, string>()
  const toKey = new Map<string, string>()
  for (const key of [...new Set(keys)].sort()) {
    let n = fnv1a(key) % SPACE
    let id = n.toString(36).padStart(4, '0')
    while (toKey.has(id)) {
      n = (n + 1) % SPACE
      id = n.toString(36).padStart(4, '0')
    }
    toId.set(key, id)
    toKey.set(id, key)
  }
  return {
    idOf: (key) => {
      const id = toId.get(key)
      return id ? `#${id}` : ''
    },
    keyOf: (ref) => {
      const m = ID_RE.exec(ref.trim())
      return m ? (toKey.get(m[1].toLowerCase()) ?? null) : null
    }
  }
}

/** Looks like an ID reference (`#k3f9`). Bare 4-char words are NOT treated as IDs. */
export function isIdRef(ref: string): boolean {
  return /^#[0-9a-z]{4}$/i.test(ref.trim())
}
