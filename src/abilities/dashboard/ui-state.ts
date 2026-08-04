import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { USER_CONFIG_DIR } from '../../main/process/paths'
import { DASHBOARD_LAYOUT_VERSION } from './types'
import { makeLogger } from '../../main/process/logger'

const log = makeLogger('dashboard-ui-state')

const UI_STATE_FILE = join(USER_CONFIG_DIR, 'ui-state.json')

interface UiState {
  dashboardLayout?: unknown[]
  dashboardLayoutVersion?: number
}

async function getUiState(): Promise<UiState> {
  try {
    return JSON.parse(await readFile(UI_STATE_FILE, 'utf-8')) as UiState
  } catch {
    return {}
  }
}

export async function getDashboardLayout(): Promise<{
  layout: unknown[]
  version: number | null
}> {
  const state = await getUiState()
  const layout = Array.isArray(state.dashboardLayout) ? state.dashboardLayout : []
  const version =
    typeof state.dashboardLayoutVersion === 'number' ? state.dashboardLayoutVersion : null
  log.info('layout get', { count: layout.length, version })
  return { layout, version }
}

export async function setDashboardLayout(layout: unknown[]): Promise<void> {
  const state = await getUiState()
  state.dashboardLayout = layout
  state.dashboardLayoutVersion = DASHBOARD_LAYOUT_VERSION
  await mkdir(USER_CONFIG_DIR, { recursive: true })
  await writeFile(UI_STATE_FILE, JSON.stringify(state, null, 2), 'utf-8')
  log.info('layout set', { count: layout.length, version: DASHBOARD_LAYOUT_VERSION })
}

export async function resetDashboardLayout(): Promise<void> {
  const state = await getUiState()
  delete state.dashboardLayout
  delete state.dashboardLayoutVersion
  await mkdir(USER_CONFIG_DIR, { recursive: true })
  await writeFile(UI_STATE_FILE, JSON.stringify(state, null, 2), 'utf-8')
  log.info('layout reset')
}
