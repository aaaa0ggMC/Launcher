import { BrowserWindow, session } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { homedir } from 'os'
import { abilityConfigPath } from '../../main/process/paths'
import { makeLogger } from '../../main/process/logger'
import { decryptSecret, encryptSecret } from './crypto'
import { getFetcher, getProfilePartition, cacheOpenAISessionAuth } from './platforms'
import type {
  BalanceConfig,
  BalanceProfile,
  BalanceProviderType,
  BalanceResult,
  PlatformConfig
} from './types'

const log = makeLogger('balance')

const DEFAULT_PROFILES: BalanceProfile[] = [
  {
    id: 'default',
    name: '默认 Profile',
    partition: getProfilePartition('default'),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    providers: {}
  }
]

const DEFAULT_CONFIG: BalanceConfig = {
  version: 1,
  settings: {
    autoRefresh: true,
    refreshIntervalSec: 900,
    timeoutSec: 15,
    concurrency: 5
  },
  profiles: DEFAULT_PROFILES,
  platforms: [
    {
      id: 'deepseek',
      name: 'DeepSeek',
      type: 'deepseek',
      apiKey: '',
      profileId: 'default',
      enabled: true,
      icon: 'gi:settings'
    },
    {
      id: 'openrouter',
      name: 'OpenRouter',
      type: 'openrouter',
      apiKey: '',
      profileId: 'default',
      enabled: true,
      icon: 'gi:settings'
    },
    {
      id: 'ppio',
      name: 'PPIO',
      type: 'ppio',
      apiKey: '',
      profileId: 'default',
      enabled: true,
      icon: 'gi:settings'
    },
    {
      id: 'tavily',
      name: 'Tavily',
      type: 'tavily',
      apiKey: '',
      profileId: 'default',
      enabled: true,
      icon: 'gi:settings'
    },
    {
      id: 'openai',
      name: 'OpenAI',
      type: 'openai',
      apiKey: '',
      profileId: 'default',
      enabled: false,
      icon: 'gi:settings'
    },
    {
      id: 'openai_web',
      name: 'OpenAI (网页端/免Key)',
      type: 'openai_web',
      apiKey: '',
      profileId: 'default',
      enabled: false,
      icon: 'gi:settings'
    },
    {
      id: 'google_ai_studio',
      name: 'Google AI Studio (网页端/免Key)',
      type: 'google_ai_studio',
      apiKey: '',
      profileId: 'default',
      enabled: false,
      icon: 'gi:settings'
    }
  ]
}

const balanceCache = new Map<string, BalanceResult>()

function maskKey(key: string): string {
  if (!key) return ''
  if (key.length <= 8) return '****'
  return `${key.slice(0, 4)}••••••••${key.slice(-4)}`
}

/**
 * Ensures the balance config file exists; handles automatic profile migration.
 */
function ensureConfig(): BalanceConfig {
  const cfgPath = abilityConfigPath('balance')

  if (!existsSync(cfgPath)) {
    const legacyPath = join(homedir(), 'Apps', 'balance_checker', 'config.json')
    if (existsSync(legacyPath)) {
      try {
        const raw = readFileSync(legacyPath, 'utf8')
        const legacy = JSON.parse(raw) as Record<string, { api_key?: string }>
        const initial = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as BalanceConfig

        for (const p of initial.platforms) {
          if (legacy[p.id]?.api_key) {
            p.apiKey = legacy[p.id].api_key || ''
            p.enabled = true
          }
        }
        saveConfigInternal(initial)
        log.info('Auto-imported legacy config from ~/Apps/balance_checker/config.json')
        return initial
      } catch (err) {
        log.warn('Failed to auto-import legacy config', { err: String(err) })
      }
    }

    saveConfigInternal(DEFAULT_CONFIG)
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as BalanceConfig
  }

  try {
    const raw = readFileSync(cfgPath, 'utf8')
    const stored = JSON.parse(raw) as BalanceConfig

    // Decrypt secrets into memory
    if (Array.isArray(stored.platforms)) {
      for (const p of stored.platforms) {
        if (p.apiKey) {
          p.apiKey = decryptSecret(p.apiKey)
        }
      }
    }

    // Profiles Migration: Ensure profiles array exists with at least a default profile
    let profiles =
      Array.isArray(stored.profiles) && stored.profiles.length > 0 ? stored.profiles : []
    if (profiles.length === 0) {
      profiles = [
        {
          id: 'default',
          name: '默认 Profile',
          partition: getProfilePartition('default'),
          createdAt: Date.now(),
          updatedAt: Date.now(),
          providers: {}
        }
      ]
    } else {
      // Normalize partitions
      profiles = profiles.map((prof) => ({
        ...prof,
        partition: getProfilePartition(prof.id),
        providers: prof.providers || {}
      }))
    }

    // Ensure all platforms have profileId
    const platforms = (stored.platforms || []).map((p) => ({
      ...p,
      profileId: p.profileId || 'default'
    }))

    const finalConfig: BalanceConfig = {
      version: stored.version || 1,
      settings: { ...DEFAULT_CONFIG.settings, ...(stored.settings || {}) },
      profiles,
      platforms
    }

    return finalConfig
  } catch (err) {
    log.error('Failed to parse balance config.json, resetting to default', { err: String(err) })
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as BalanceConfig
  }
}

function saveConfigInternal(config: BalanceConfig): void {
  const cfgPath = abilityConfigPath('balance')
  const dir = dirname(cfgPath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  // Clone config to encrypt API keys on disk
  const toStore: BalanceConfig = {
    version: config.version || 1,
    settings: config.settings,
    profiles: config.profiles || DEFAULT_PROFILES,
    platforms: config.platforms.map((p) => ({
      ...p,
      apiKey: p.apiKey ? encryptSecret(p.apiKey) : ''
    }))
  }

  writeFileSync(cfgPath, JSON.stringify(toStore, null, 2), 'utf8')
}

/**
 * Returns balance configuration with optionally masked or revealed keys.
 */
export async function getBalanceConfig(options?: {
  revealSecrets?: boolean
}): Promise<BalanceConfig> {
  const cfg = ensureConfig()
  const reveal = options?.revealSecrets === true

  return {
    version: cfg.version,
    settings: cfg.settings,
    profiles: cfg.profiles,
    platforms: cfg.platforms.map((p) => ({
      ...p,
      apiKey: reveal ? p.apiKey : maskKey(p.apiKey)
    }))
  }
}

/**
 * Saves balance configuration, updating encrypted keys in storage.
 */
export async function saveBalanceConfig(config: BalanceConfig): Promise<void> {
  const current = ensureConfig()
  const currentKeyMap = new Map(current.platforms.map((p) => [p.id, p.apiKey]))

  const updatedPlatforms: PlatformConfig[] = config.platforms.map((p) => {
    let finalKey = p.apiKey
    if (finalKey && finalKey.includes('••••••••')) {
      finalKey = currentKeyMap.get(p.id) || ''
    }
    return {
      ...p,
      apiKey: finalKey,
      profileId: p.profileId || 'default'
    }
  })

  const merged: BalanceConfig = {
    version: config.version || 1,
    settings: { ...DEFAULT_CONFIG.settings, ...config.settings },
    profiles: config.profiles && config.profiles.length > 0 ? config.profiles : current.profiles,
    platforms: updatedPlatforms
  }

  saveConfigInternal(merged)
  log.info('Saved balance config')
}

/**
 * Upserts a single platform.
 */
export async function upsertPlatform(platform: PlatformConfig): Promise<PlatformConfig> {
  const config = ensureConfig()
  const idx = config.platforms.findIndex((p) => p.id === platform.id)

  let finalKey = platform.apiKey
  if (idx >= 0 && finalKey && finalKey.includes('••••••••')) {
    finalKey = config.platforms[idx].apiKey
  }

  const updated: PlatformConfig = {
    ...platform,
    apiKey: finalKey,
    profileId: platform.profileId || 'default'
  }

  if (idx >= 0) {
    config.platforms[idx] = updated
  } else {
    config.platforms.push(updated)
  }

  saveConfigInternal(config)
  return updated
}

/**
 * Removes a platform by id.
 */
export async function removePlatform(id: string): Promise<boolean> {
  const config = ensureConfig()
  const prevLen = config.platforms.length
  config.platforms = config.platforms.filter((p) => p.id !== id)
  if (config.platforms.length !== prevLen) {
    saveConfigInternal(config)
    balanceCache.delete(id)
    return true
  }
  return false
}

// -------------------------------------------------------------
// PROFILE MANAGEMENT API
// -------------------------------------------------------------

/**
 * Resolves a profile ID from a profileId or platformId.
 */
export function resolveProfileId(idOrPlatformId?: string): string {
  const config = ensureConfig()
  if (!idOrPlatformId) return config.profiles[0]?.id || 'default'

  // If matches an existing profile ID directly
  const foundProfile = config.profiles.find((p) => p.id === idOrPlatformId)
  if (foundProfile) return foundProfile.id

  // If matches a platform ID, look up platform.profileId
  const foundPlatform = config.platforms.find((p) => p.id === idOrPlatformId)
  if (foundPlatform?.profileId) return foundPlatform.profileId

  return config.profiles[0]?.id || 'default'
}

/**
 * Detects whether a provider is logged in inside a given partition session.
 */
async function detectProviderAuth(
  ses: Electron.Session,
  provider: BalanceProviderType
): Promise<boolean> {
  try {
    const cookies = await ses.cookies.get({})
    if (provider === 'openai') {
      return cookies.some(
        (c) =>
          c.domain?.includes('openai.com') ||
          c.domain?.includes('chatgpt.com') ||
          c.domain?.includes('auth0.com')
      )
    }
    if (provider === 'mimo') {
      return cookies.some(
        (c) =>
          c.domain?.includes('xiaomimimo.com') ||
          c.domain?.includes('xiaomi.com') ||
          c.domain?.includes('mi.com') ||
          c.name.includes('userId') ||
          c.name.includes('serviceToken') ||
          c.name.includes('passToken')
      )
    }
    if (provider === 'bigmodel') {
      return cookies.some(
        (c) =>
          c.domain?.includes('bigmodel.cn') ||
          c.domain?.includes('zhipuai.cn') ||
          c.name.includes('token') ||
          c.name.includes('session') ||
          c.name.includes('auth') ||
          c.name.includes('userId')
      )
    }
    if (provider === 'google') {
      return cookies.some(
        (c) =>
          c.domain?.includes('google.com') &&
          (c.name.includes('SID') || c.name.includes('SSID') || c.name.includes('HSID'))
      )
    }
  } catch (err) {
    log.warn(`Error detecting auth for provider ${provider}:`, { err: String(err) })
  }
  return false
}

/**
 * Returns all profiles with live provider status checked.
 */
export async function listProfiles(): Promise<BalanceProfile[]> {
  const config = ensureConfig()
  const providers: BalanceProviderType[] = ['openai', 'mimo', 'bigmodel', 'google']

  const tasks = config.profiles.map(async (profile) => {
    const partition = getProfilePartition(profile.id)
    const ses = session.fromPartition(partition)
    const statusMap: Partial<
      Record<BalanceProviderType, { isLoggedIn: boolean; lastChecked: number }>
    > = {}

    await Promise.all(
      providers.map(async (prov) => {
        const loggedIn = await detectProviderAuth(ses, prov)
        statusMap[prov] = {
          isLoggedIn: loggedIn,
          lastChecked: Date.now()
        }
      })
    )

    return {
      ...profile,
      partition,
      providers: statusMap
    }
  })

  const results = await Promise.all(tasks)
  return results
}

/**
 * Creates or updates a profile.
 */
export async function upsertProfile(profile: {
  id?: string
  name: string
}): Promise<BalanceProfile> {
  const config = ensureConfig()
  const id = profile.id?.trim() || `profile_${Date.now().toString(36)}`
  const name = profile.name?.trim() || '未命名 Profile'

  const idx = config.profiles.findIndex((p) => p.id === id)
  const partition = getProfilePartition(id)
  const now = Date.now()

  let finalProfile: BalanceProfile
  if (idx >= 0) {
    finalProfile = {
      ...config.profiles[idx],
      name,
      partition,
      updatedAt: now
    }
    config.profiles[idx] = finalProfile
  } else {
    finalProfile = {
      id,
      name,
      partition,
      createdAt: now,
      updatedAt: now,
      providers: {}
    }
    config.profiles.push(finalProfile)
  }

  saveConfigInternal(config)
  return finalProfile
}

/**
 * Removes a profile by ID, unbinding associated platforms and clearing storage data.
 */
export async function removeProfile(
  id: string,
  options?: { clearStorage?: boolean }
): Promise<boolean> {
  const config = ensureConfig()
  if (id === 'default' && config.profiles.length <= 1) {
    throw new Error('不能删除仅有的默认 Profile')
  }

  const prevLen = config.profiles.length
  config.profiles = config.profiles.filter((p) => p.id !== id)

  if (config.profiles.length !== prevLen) {
    // Unbind platforms using this profile
    const fallbackProfileId = config.profiles[0]?.id || 'default'
    for (const p of config.platforms) {
      if (p.profileId === id) {
        p.profileId = fallbackProfileId
      }
    }

    if (options?.clearStorage !== false) {
      try {
        const partition = getProfilePartition(id)
        const ses = session.fromPartition(partition)
        await ses.clearStorageData()
      } catch (err) {
        log.warn(`Failed to clear session data for deleted profile ${id}:`, { err: String(err) })
      }
    }

    saveConfigInternal(config)
    return true
  }
  return false
}

/**
 * Checks and updates live provider statuses for a single profile.
 */
export async function checkProfileStatus(profileId: string): Promise<BalanceProfile> {
  const config = ensureConfig()
  const profile = config.profiles.find((p) => p.id === profileId)
  if (!profile) throw new Error(`未找到 Profile: ${profileId}`)

  const partition = getProfilePartition(profile.id)
  const ses = session.fromPartition(partition)
  const providers: BalanceProviderType[] = ['openai', 'mimo', 'bigmodel', 'google']
  const statusMap: Partial<
    Record<BalanceProviderType, { isLoggedIn: boolean; lastChecked: number }>
  > = {}

  await Promise.all(
    providers.map(async (prov) => {
      const loggedIn = await detectProviderAuth(ses, prov)
      statusMap[prov] = {
        isLoggedIn: loggedIn,
        lastChecked: Date.now()
      }
    })
  )

  profile.providers = statusMap
  profile.updatedAt = Date.now()
  saveConfigInternal(config)

  return { ...profile, partition }
}

/**
 * Opens a login window for a specific provider within a Profile's partition.
 */
export async function loginProfileProvider(
  profileId: string,
  provider: BalanceProviderType,
  customUrl?: string
): Promise<{ ok: boolean; loggedIn: boolean }> {
  const partition = getProfilePartition(profileId)
  const ses = session.fromPartition(partition)

  const CHROME_UA =
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
  const FIREFOX_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0'

  if (provider === 'openai') {
    return new Promise((resolve) => {
      const win = new BrowserWindow({
        width: 540,
        height: 740,
        title: '登录 OpenAI 账号',
        autoHideMenuBar: true,
        webPreferences: {
          partition,
          sandbox: false,
          backgroundThrottling: false
        }
      })

      win.webContents.session.webRequest.onBeforeSendHeaders(
        { urls: ['https://api.openai.com/*', 'https://platform.openai.com/*'] },
        (details, callback) => {
          const auth =
            details.requestHeaders['Authorization'] || details.requestHeaders['authorization']
          const org =
            details.requestHeaders['Openai-Organization'] ||
            details.requestHeaders['openai-organization']
          if (auth && auth.includes('sess-')) {
            cacheOpenAISessionAuth(partition, auth, org)
          }
          callback({ requestHeaders: details.requestHeaders })
        }
      )

      let resolved = false
      const checkLogin = async (url: string): Promise<void> => {
        if (
          url.includes('platform.openai.com/home') ||
          url.includes('platform.openai.com/settings') ||
          url.includes('platform.openai.com/usage') ||
          url.includes('platform.openai.com/overview') ||
          (url.includes('platform.openai.com') &&
            !url.includes('/login') &&
            !url.includes('/auth') &&
            !url.includes('auth.openai.com'))
        ) {
          if (!resolved) {
            resolved = true
            log.info(`OpenAI login success in profile: ${profileId}`)
            try {
              await win.webContents.session.cookies.flushStore()
            } catch {
              /* ignore */
            }
            setTimeout(() => {
              if (!win.isDestroyed()) win.close()
            }, 1200)
            resolve({ ok: true, loggedIn: true })
          }
        }
      }

      win.webContents.on('did-navigate', (_, url) => checkLogin(url))
      win.webContents.on('did-navigate-in-page', (_, url) => checkLogin(url))

      win.on('closed', async () => {
        if (!resolved) {
          resolved = true
          const hasAuth = await detectProviderAuth(ses, 'openai')
          resolve({ ok: true, loggedIn: hasAuth })
        }
      })

      win.loadURL('https://platform.openai.com/login?next=%2Fhome')
    })
  }

  if (provider === 'mimo') {
    return new Promise((resolve) => {
      const win = new BrowserWindow({
        width: 720,
        height: 800,
        title: '登录小米账号 (MiMo)',
        autoHideMenuBar: true,
        webPreferences: {
          partition,
          sandbox: false,
          backgroundThrottling: false
        }
      })

      let resolved = false
      let hasEnteredLogin = false

      const checkLogin = async (url: string): Promise<void> => {
        try {
          const parsed = new URL(url)
          if (
            parsed.hostname.includes('account.xiaomi.com') ||
            parsed.pathname.includes('/login')
          ) {
            hasEnteredLogin = true
          } else if (hasEnteredLogin && parsed.hostname.includes('xiaomimimo.com')) {
            const hasAuth = await detectProviderAuth(ses, 'mimo')
            if (hasAuth && !resolved) {
              resolved = true
              log.info(`Xiaomi MiMo login success in profile: ${profileId}`)
              try {
                await win.webContents.session.cookies.flushStore()
              } catch {
                /* ignore */
              }
              setTimeout(() => {
                if (!win.isDestroyed()) win.close()
              }, 1200)
              resolve({ ok: true, loggedIn: true })
            }
          }
        } catch {
          /* ignore */
        }
      }

      win.webContents.on('did-navigate', (_, url) => checkLogin(url))
      win.webContents.on('did-navigate-in-page', (_, url) => checkLogin(url))

      win.on('closed', async () => {
        if (!resolved) {
          resolved = true
          const hasAuth = await detectProviderAuth(ses, 'mimo')
          resolve({ ok: true, loggedIn: hasAuth })
        }
      })

      const targetUrl = customUrl?.trim() || 'https://platform.xiaomimimo.com/console/balance'
      win.loadURL(targetUrl)
    })
  }

  if (provider === 'bigmodel') {
    return new Promise((resolve) => {
      const win = new BrowserWindow({
        width: 780,
        height: 820,
        title: '登录智谱 BigModel 账号',
        autoHideMenuBar: true,
        webPreferences: {
          partition,
          sandbox: false,
          backgroundThrottling: false
        }
      })

      let resolved = false
      let hasEnteredLogin = false

      const checkLogin = async (url: string): Promise<void> => {
        try {
          const parsed = new URL(url)
          if (
            parsed.pathname.includes('/login') ||
            parsed.pathname.includes('/passport') ||
            parsed.hostname.includes('passport')
          ) {
            hasEnteredLogin = true
          } else if (
            hasEnteredLogin &&
            (parsed.pathname.includes('/finance-center') ||
              parsed.pathname.includes('/console') ||
              parsed.pathname.includes('/overview') ||
              parsed.pathname.includes('/modelcenter'))
          ) {
            const hasAuth = await detectProviderAuth(ses, 'bigmodel')
            if (hasAuth && !resolved) {
              resolved = true
              log.info(`BigModel login success in profile: ${profileId}`)
              try {
                await win.webContents.session.cookies.flushStore()
              } catch {
                /* ignore */
              }
              setTimeout(() => {
                if (!win.isDestroyed()) win.close()
              }, 1200)
              resolve({ ok: true, loggedIn: true })
            }
          }
        } catch {
          /* ignore */
        }
      }

      win.webContents.on('did-navigate', (_, url) => checkLogin(url))
      win.webContents.on('did-navigate-in-page', (_, url) => checkLogin(url))

      win.on('closed', async () => {
        if (!resolved) {
          resolved = true
          const hasAuth = await detectProviderAuth(ses, 'bigmodel')
          resolve({ ok: true, loggedIn: hasAuth })
        }
      })

      const targetUrl = customUrl?.trim() || 'https://bigmodel.cn/finance-center/finance/overview'
      win.loadURL(targetUrl)
    })
  }

  if (provider === 'google') {
    return new Promise((resolve) => {
      ses.setUserAgent(CHROME_UA)
      ses.webRequest.onBeforeSendHeaders(
        { urls: ['https://accounts.google.com/*'] },
        (details, callback) => {
          details.requestHeaders['User-Agent'] = FIREFOX_UA
          delete details.requestHeaders['sec-ch-ua']
          delete details.requestHeaders['sec-ch-ua-mobile']
          delete details.requestHeaders['sec-ch-ua-platform']
          delete details.requestHeaders['sec-ch-ua-platform-version']
          callback({ requestHeaders: details.requestHeaders })
        }
      )

      const win = new BrowserWindow({
        width: 580,
        height: 750,
        title: '登录 Google 账号',
        autoHideMenuBar: true,
        webPreferences: {
          partition,
          sandbox: false,
          backgroundThrottling: false
        }
      })

      let resolved = false
      let hasEnteredAccounts = false

      const checkLogin = async (url: string): Promise<void> => {
        try {
          const parsed = new URL(url)
          if (parsed.hostname.includes('accounts.google.com')) {
            hasEnteredAccounts = true
          } else if (hasEnteredAccounts && parsed.hostname === 'aistudio.google.com') {
            if (!resolved) {
              resolved = true
              log.info(`Google login success in profile: ${profileId}`)
              try {
                await win.webContents.session.cookies.flushStore()
              } catch {
                /* ignore */
              }
              setTimeout(() => {
                if (!win.isDestroyed()) win.close()
              }, 1200)
              resolve({ ok: true, loggedIn: true })
            }
          }
        } catch {
          /* ignore */
        }
      }

      win.webContents.on('did-navigate', (_, url) => checkLogin(url))
      win.webContents.on('did-navigate-in-page', (_, url) => checkLogin(url))

      win.on('closed', async () => {
        if (!resolved) {
          resolved = true
          const hasAuth = await detectProviderAuth(ses, 'google')
          resolve({ ok: true, loggedIn: hasAuth })
        }
      })

      const targetUrl = customUrl?.trim() || 'https://aistudio.google.com/billing'
      win.loadURL(
        `https://accounts.google.com/ServiceLogin?continue=${encodeURIComponent(targetUrl)}&passive=1209600&followup=${encodeURIComponent(targetUrl)}`
      )
    })
  }

  return { ok: false, loggedIn: false }
}

/**
 * Clears stored cookies and session storage for a profile.
 */
export async function logoutProfileProvider(
  profileId: string,
  provider?: BalanceProviderType
): Promise<{ ok: boolean }> {
  const partition = getProfilePartition(profileId)
  const ses = session.fromPartition(partition)

  if (!provider) {
    await ses.clearStorageData()
    log.info(`Cleared all session storage for profile: ${profileId}`)
    return { ok: true }
  }

  const domainMap: Record<BalanceProviderType, string[]> = {
    openai: ['openai.com', 'chatgpt.com', 'auth0.com'],
    mimo: ['xiaomimimo.com', 'xiaomi.com', 'mi.com'],
    bigmodel: ['bigmodel.cn', 'zhipuai.cn'],
    google: ['google.com', 'aistudio.google.com']
  }

  const domains = domainMap[provider] || []
  const cookies = await ses.cookies.get({})
  for (const c of cookies) {
    if (domains.some((d) => c.domain?.includes(d))) {
      const protocol = c.secure ? 'https' : 'http'
      const host = c.domain?.startsWith('.') ? c.domain.slice(1) : c.domain
      const url = `${protocol}://${host}${c.path}`
      try {
        await ses.cookies.remove(url, c.name)
      } catch {
        /* ignore */
      }
    }
  }

  log.info(`Cleared ${provider} cookies for profile: ${profileId}`)
  return { ok: true }
}

/**
 * Opens a browser window in a Profile's partition for a provider's console.
 */
export async function openProfileWindow(
  profileId: string,
  provider: BalanceProviderType,
  targetUrl?: string,
  title?: string
): Promise<{ ok: boolean }> {
  const partition = getProfilePartition(profileId)
  const ses = session.fromPartition(partition)

  const CHROME_UA =
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
  const FIREFOX_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0'

  ses.setUserAgent(CHROME_UA)

  ses.webRequest.onBeforeSendHeaders(
    { urls: ['https://accounts.google.com/*'] },
    (details, callback) => {
      details.requestHeaders['User-Agent'] = FIREFOX_UA
      delete details.requestHeaders['sec-ch-ua']
      delete details.requestHeaders['sec-ch-ua-mobile']
      delete details.requestHeaders['sec-ch-ua-platform']
      delete details.requestHeaders['sec-ch-ua-platform-version']
      callback({ requestHeaders: details.requestHeaders })
    }
  )

  const win = new BrowserWindow({
    width: 1100,
    height: 780,
    title: title || '控制台',
    autoHideMenuBar: true,
    webPreferences: {
      partition,
      sandbox: false,
      backgroundThrottling: false
    }
  })

  const urlMap: Record<BalanceProviderType, string> = {
    openai: 'https://platform.openai.com/home',
    mimo: 'https://platform.xiaomimimo.com/console/balance',
    bigmodel: 'https://bigmodel.cn/finance-center/finance/overview',
    google: 'https://aistudio.google.com/billing'
  }

  const finalUrl = targetUrl?.trim() || urlMap[provider] || 'https://google.com'
  win.loadURL(finalUrl)

  return { ok: true }
}

// -------------------------------------------------------------
// BACKWARD COMPATIBILITY DELEGATES
// -------------------------------------------------------------

export async function loginOpenAIWeb(
  profileOrPlatformId = 'default'
): Promise<{ ok: boolean; loggedIn: boolean }> {
  return await loginProfileProvider(resolveProfileId(profileOrPlatformId), 'openai')
}

export async function logoutOpenAIWeb(profileOrPlatformId = 'default'): Promise<void> {
  await logoutProfileProvider(resolveProfileId(profileOrPlatformId), 'openai')
}

export async function loginGoogleWeb(
  profileOrPlatformId = 'default',
  customUrl?: string
): Promise<{ ok: boolean; loggedIn: boolean }> {
  return await loginProfileProvider(resolveProfileId(profileOrPlatformId), 'google', customUrl)
}

export async function logoutGoogleWeb(profileOrPlatformId = 'default'): Promise<void> {
  await logoutProfileProvider(resolveProfileId(profileOrPlatformId), 'google')
}

export async function loginMimoWeb(
  profileOrPlatformId = 'default',
  customUrl?: string
): Promise<{ ok: boolean; loggedIn: boolean }> {
  return await loginProfileProvider(resolveProfileId(profileOrPlatformId), 'mimo', customUrl)
}

export async function logoutMimoWeb(profileOrPlatformId = 'default'): Promise<void> {
  await logoutProfileProvider(resolveProfileId(profileOrPlatformId), 'mimo')
}

export async function loginBigModelWeb(
  profileOrPlatformId = 'default',
  customUrl?: string
): Promise<{ ok: boolean; loggedIn: boolean }> {
  return await loginProfileProvider(resolveProfileId(profileOrPlatformId), 'bigmodel', customUrl)
}

export async function logoutBigModelWeb(profileOrPlatformId = 'default'): Promise<void> {
  await logoutProfileProvider(resolveProfileId(profileOrPlatformId), 'bigmodel')
}

export async function openPlatformWindow(
  platformId: string,
  platformType?: string,
  targetUrl?: string,
  title?: string
): Promise<{ ok: boolean }> {
  const profileId = resolveProfileId(platformId)
  let provider: BalanceProviderType = 'google'
  if (platformType?.includes('openai')) provider = 'openai'
  else if (platformType?.includes('mimo')) provider = 'mimo'
  else if (platformType?.includes('bigmodel')) provider = 'bigmodel'
  else if (platformType?.includes('google')) provider = 'google'

  return await openProfileWindow(profileId, provider, targetUrl, title)
}

// -------------------------------------------------------------
// BALANCE CHECKING & RESULTS
// -------------------------------------------------------------

/**
 * Checks a single platform balance.
 */
export async function checkSinglePlatform(id: string): Promise<BalanceResult> {
  const config = ensureConfig()
  const platform = config.platforms.find((p) => p.id === id)

  if (!platform) {
    const errResult: BalanceResult = {
      id,
      name: id,
      type: 'custom',
      currency: 'USD',
      amount: 0,
      error: '未找到该平台配置',
      updatedAt: Date.now()
    }
    balanceCache.set(id, errResult)
    return errResult
  }

  const profile = config.profiles.find((pr) => pr.id === platform.profileId)
  const timeoutMs = (config.settings?.timeoutSec || 10) * 1000
  const fetcher = getFetcher(platform.type)

  try {
    const result = await fetcher.fetchBalance(platform, timeoutMs)
    const finalResult: BalanceResult = {
      ...result,
      profileId: platform.profileId,
      profileName: profile?.name
    }
    balanceCache.set(id, finalResult)
    return finalResult
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err)
    const errResult: BalanceResult = {
      id: platform.id,
      name: platform.name,
      type: platform.type,
      icon: platform.icon || fetcher.defaultIcon,
      currency: 'USD',
      amount: 0,
      error: errMsg,
      updatedAt: Date.now(),
      profileId: platform.profileId,
      profileName: profile?.name
    }
    balanceCache.set(id, errResult)
    log.warn(`Balance check failed for ${platform.name}: ${errMsg}`)
    return errResult
  }
}

/**
 * Checks all enabled platforms in parallel.
 */
export async function checkAllPlatforms(): Promise<BalanceResult[]> {
  const config = ensureConfig()
  const enabled = config.platforms.filter((p) => p.enabled)

  const tasks = enabled.map(async (p) => {
    return await checkSinglePlatform(p.id)
  })

  const results = await Promise.all(tasks)
  return results
}

/**
 * Returns cached results combined with platform config stubs if unpolled.
 */
export async function getCachedBalances(): Promise<BalanceResult[]> {
  const config = ensureConfig()
  const results: BalanceResult[] = []

  for (const p of config.platforms) {
    const cached = balanceCache.get(p.id)
    const profile = config.profiles.find((pr) => pr.id === p.profileId)
    if (cached) {
      results.push({
        ...cached,
        profileId: p.profileId,
        profileName: profile?.name
      })
    } else {
      const fetcher = getFetcher(p.type)
      results.push({
        id: p.id,
        name: p.name,
        type: p.type,
        icon: p.icon || fetcher.defaultIcon,
        currency: 'USD',
        amount: 0,
        error: null,
        updatedAt: 0,
        profileId: p.profileId,
        profileName: profile?.name
      })
    }
  }

  return results
}

/**
 * Imports configuration from external path (default ~/Apps/balance_checker/config.json).
 */
export async function importLegacyConfig(filePath?: string): Promise<{ count: number }> {
  const target = filePath || join(homedir(), 'Apps', 'balance_checker', 'config.json')
  if (!existsSync(target)) {
    throw new Error(`未找到文件: ${target}`)
  }

  const raw = readFileSync(target, 'utf8')
  const legacy = JSON.parse(raw) as Record<string, { api_key?: string }>
  const config = ensureConfig()
  let count = 0

  for (const [key, val] of Object.entries(legacy)) {
    if (!val || typeof val !== 'object') continue
    const apiKey = val.api_key || ''
    if (!apiKey) continue

    const existing = config.platforms.find((p) => p.id === key)
    if (existing) {
      existing.apiKey = apiKey
      existing.enabled = true
      count++
    } else {
      const fetcher = getFetcher(key)
      config.platforms.push({
        id: key,
        name: fetcher.defaultName || key,
        type: key,
        apiKey,
        profileId: 'default',
        enabled: true,
        icon: fetcher.defaultIcon
      })
      count++
    }
  }

  saveConfigInternal(config)
  log.info(`Imported ${count} platform configs from ${target}`)
  return { count }
}
