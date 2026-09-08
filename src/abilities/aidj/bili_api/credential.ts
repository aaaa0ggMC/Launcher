import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

export interface BiliCredentialOptions {
  sessdata?: string
  bili_jct?: string
  buvid3?: string
  buvid4?: string
  dedeuserid?: string
  ac_time_value?: string
  [key: string]: string | undefined
}

export class BiliCredential {
  public sessdata?: string
  public bili_jct?: string
  public buvid3?: string
  public buvid4?: string
  public dedeuserid?: string
  public ac_time_value?: string
  public extraCookies: Record<string, string> = {}

  constructor(options: BiliCredentialOptions = {}) {
    this.sessdata = options.sessdata
    this.bili_jct = options.bili_jct
    this.buvid3 = options.buvid3
    this.buvid4 = options.buvid4
    this.dedeuserid = options.dedeuserid
    this.ac_time_value = options.ac_time_value

    for (const [k, v] of Object.entries(options)) {
      if (
        !['sessdata', 'bili_jct', 'buvid3', 'buvid4', 'dedeuserid', 'ac_time_value'].includes(
          k.toLowerCase()
        ) &&
        v
      ) {
        this.extraCookies[k] = v
      }
    }
  }

  public hasSessdata(): boolean {
    return Boolean(this.sessdata && this.sessdata.trim() !== '')
  }

  public getCookieMap(): Record<string, string> {
    const map: Record<string, string> = { ...this.extraCookies }
    if (this.sessdata) map['SESSDATA'] = this.sessdata
    if (this.bili_jct) map['bili_jct'] = this.bili_jct
    if (this.buvid3) map['buvid3'] = this.buvid3
    if (this.buvid4) map['buvid4'] = this.buvid4
    if (this.dedeuserid) map['DedeUserID'] = this.dedeuserid
    if (this.ac_time_value) map['ac_time_value'] = this.ac_time_value
    return map
  }

  public toCookieString(): string {
    const map = this.getCookieMap()
    return Object.entries(map)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ')
  }

  public static getCockpitCredentialPath(): string {
    return path.join(os.homedir(), '.config', 'LinuxCockpit', 'aidj', 'bili_credential.json')
  }

  public static getFallbackAppPath(): string {
    return path.join(os.homedir(), 'Apps', 'bili_info.json')
  }

  /**
   * Parse credentials from a raw string, supporting JSON object or standard Cookie header string.
   */
  public static parseFromString(raw: string): BiliCredential {
    const text = raw.trim()
    if (!text) return new BiliCredential()

    if (text.startsWith('{')) {
      try {
        const json = JSON.parse(text)
        const opts: BiliCredentialOptions = {}
        if (json.credential && typeof json.credential === 'object') {
          Object.assign(opts, json.credential)
        }
        if (json.cookies && typeof json.cookies === 'object') {
          for (const [k, v] of Object.entries(json.cookies)) {
            if (typeof v === 'string') opts[k] = v
          }
        }
        for (const [k, v] of Object.entries(json)) {
          if (typeof v === 'string' && !opts[k]) {
            opts[k] = v
          }
        }
        // Normalize common keys
        if (!opts.sessdata && opts.SESSDATA) opts.sessdata = opts.SESSDATA
        if (!opts.bili_jct && opts.BILI_JCT) opts.bili_jct = opts.BILI_JCT
        if (!opts.dedeuserid && (opts.DedeUserID || opts.dede_user_id)) {
          opts.dedeuserid = opts.DedeUserID || opts.dede_user_id
        }
        return new BiliCredential(opts)
      } catch {
        /* Fall back to cookie parsing */
      }
    }

    // Parse as Cookie string (e.g. SESSDATA=xxx; bili_jct=yyy; ...)
    const opts: BiliCredentialOptions = {}
    const pairs = text.split(';')
    for (const pair of pairs) {
      const idx = pair.indexOf('=')
      if (idx === -1) continue
      const key = pair.slice(0, idx).trim()
      const val = pair.slice(idx + 1).trim()
      if (!key || !val) continue

      const lower = key.toLowerCase()
      if (lower === 'sessdata') opts.sessdata = val
      else if (lower === 'bili_jct') opts.bili_jct = val
      else if (lower === 'buvid3') opts.buvid3 = val
      else if (lower === 'buvid4') opts.buvid4 = val
      else if (lower === 'dedeuserid') opts.dedeuserid = val
      else if (lower === 'ac_time_value') opts.ac_time_value = val
      else opts[key] = val
    }

    return new BiliCredential(opts)
  }

  /**
   * Load credential from an explicit file path.
   */
  public static fromFile(filePath: string): BiliCredential {
    if (!fs.existsSync(filePath)) {
      throw new Error(`凭据文件不存在: ${filePath}`)
    }
    const content = fs.readFileSync(filePath, 'utf-8')
    return BiliCredential.parseFromString(content)
  }

  /**
   * Save credential to Cockpit AIDJ config directory or specified path.
   */
  public save(targetPath?: string): string {
    const dest = targetPath || BiliCredential.getCockpitCredentialPath()
    const dir = path.dirname(dest)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }

    const data = {
      credential: {
        sessdata: this.sessdata || '',
        bili_jct: this.bili_jct || '',
        buvid3: this.buvid3 || '',
        buvid4: this.buvid4 || '',
        dedeuserid: this.dedeuserid || '',
        ac_time_value: this.ac_time_value || ''
      },
      cookies: this.getCookieMap()
    }

    fs.writeFileSync(dest, JSON.stringify(data, null, 2), 'utf-8')
    return dest
  }

  /**
   * Remove saved credential file.
   */
  public static clear(targetPath?: string): void {
    const dest = targetPath || BiliCredential.getCockpitCredentialPath()
    if (fs.existsSync(dest)) {
      fs.unlinkSync(dest)
    }
  }

  /**
   * Load credential by priority:
   * 1. customPath (if specified and exists)
   * 2. Cockpit saved file (~/.config/LinuxCockpit/aidj/bili_credential.json)
   * 3. Fallback apps file (~/Apps/bili_info.json)
   */
  public static resolve(customPath?: string): {
    credential: BiliCredential
    sourcePath: string | null
  } {
    if (customPath && fs.existsSync(customPath)) {
      try {
        const cred = BiliCredential.fromFile(customPath)
        if (cred.hasSessdata()) {
          return { credential: cred, sourcePath: customPath }
        }
      } catch {
        /* fallback */
      }
    }

    const cockpitPath = BiliCredential.getCockpitCredentialPath()
    if (fs.existsSync(cockpitPath)) {
      try {
        const cred = BiliCredential.fromFile(cockpitPath)
        if (cred.hasSessdata()) {
          return { credential: cred, sourcePath: cockpitPath }
        }
      } catch {
        /* fallback */
      }
    }

    const fallbackPath = BiliCredential.getFallbackAppPath()
    if (fs.existsSync(fallbackPath)) {
      try {
        const cred = BiliCredential.fromFile(fallbackPath)
        if (cred.hasSessdata()) {
          return { credential: cred, sourcePath: fallbackPath }
        }
      } catch {
        /* fallback */
      }
    }

    // Fallback: return file even if sessdata is empty so UI knows configured path
    if (cockpitPath && fs.existsSync(cockpitPath)) {
      try {
        return { credential: BiliCredential.fromFile(cockpitPath), sourcePath: cockpitPath }
      } catch {
        /* fallback */
      }
    }

    if (fallbackPath && fs.existsSync(fallbackPath)) {
      try {
        return { credential: BiliCredential.fromFile(fallbackPath), sourcePath: fallbackPath }
      } catch {
        /* fallback */
      }
    }

    return { credential: new BiliCredential(), sourcePath: null }
  }

  /**
   * Backward-compatible default loader.
   */
  public static loadDefault(customPath?: string): BiliCredential {
    return BiliCredential.resolve(customPath).credential
  }
}
