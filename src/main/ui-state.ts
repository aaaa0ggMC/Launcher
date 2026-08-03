import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { USER_CONFIG_DIR } from './paths'

const UI_STATE_FILE = join(USER_CONFIG_DIR, 'ui-state.json')

interface UiState {
  dashboardLayout?: unknown[]
}

async function getUiState(): Promise<UiState> {
  try {
    return JSON.parse(await readFile(UI_STATE_FILE, 'utf-8')) as UiState
  } catch {
    return {}
  }
}

export async function getDashboardLayout(): Promise<unknown[]> {
  const state = await getUiState()
  return Array.isArray(state.dashboardLayout) ? state.dashboardLayout : []
}

export async function setDashboardLayout(layout: unknown[]): Promise<void> {
  const state = await getUiState()
  state.dashboardLayout = layout
  await mkdir(USER_CONFIG_DIR, { recursive: true })
  await writeFile(UI_STATE_FILE, JSON.stringify(state, null, 2), 'utf-8')
}

export async function resetDashboardLayout(): Promise<void> {
  const state = await getUiState()
  delete state.dashboardLayout
  await mkdir(USER_CONFIG_DIR, { recursive: true })
  await writeFile(UI_STATE_FILE, JSON.stringify(state, null, 2), 'utf-8')
}
