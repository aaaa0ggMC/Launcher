import { ref, type Ref } from 'vue'

/**
 * LocalStorage-backed reactive state (Vue port of the original React
 * useLocalStorage hook). Templates / globals / saved values / history persist
 * per-browser. Import/export of this data goes through backend commands; the
 * runtime state itself lives in localStorage like other UI prefs.
 */
export function useLocalStorage<T>(key: string, initial: T): [Ref<T>, (v: T) => void] {
  const stored = ref<T>(initial) as Ref<T>
  try {
    const raw = localStorage.getItem(key)
    if (raw) stored.value = JSON.parse(raw) as T
  } catch {
    // fall back to initial
  }

  const set = (v: T): void => {
    stored.value = v
    localStorage.setItem(key, JSON.stringify(v))
  }

  return [stored, set]
}
