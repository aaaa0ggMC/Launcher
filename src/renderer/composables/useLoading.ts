import { ref } from 'vue'

/** Standardized loading/error state shared by all abilities. */
export function useLoading() {
  const loading = ref(false)
  const error = ref('')

  async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    loading.value = true
    error.value = ''
    try {
      return await fn()
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
      return undefined
    } finally {
      loading.value = false
    }
  }

  function clearError(): void {
    error.value = ''
  }

  return { loading, error, run, clearError }
}
