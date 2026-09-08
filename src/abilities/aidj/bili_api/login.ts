import QRCode from 'qrcode'
import { makeLogger } from '../../../main/process/logger'
import type { BiliClient } from './client'
import { BiliCredential } from './credential'

const log = makeLogger('bili-login')

export interface BiliNavProfile {
  isLogin: boolean
  mid?: number
  uname?: string
  face?: string
  money?: number
  level?: number
  vipType?: number // 0 = none, 1 = month, 2 = year
  vipStatus?: number // 1 = active
  vipDueDate?: number
}

export enum QrCodeStatus {
  NOT_SCANNED = 86101,
  WAITING_CONFIRM = 86090,
  EXPIRED = 86038,
  SUCCESS = 0
}

export interface QrCodeGenerateResult {
  url: string
  qrcode_key: string
  qrDataUrl: string
}

export interface QrCodePollResult {
  code: number
  message: string
  url?: string
  refresh_token?: string
  credential?: BiliCredential
}

/**
 * Fetch current user navigation profile (login state, VIP, avatar, etc.).
 */
export async function getNavProfile(client: BiliClient): Promise<BiliNavProfile> {
  try {
    const raw = await client.rawRequest('https://api.bilibili.com/x/web-interface/nav', {
      method: 'GET'
    })
    const res = raw as {
      code?: number
      data?: {
        isLogin?: boolean
        mid?: number
        uname?: string
        face?: string
        money?: number
        level_info?: { current_level?: number }
        vipType?: number
        vipStatus?: number
        vipDueDate?: number
      }
    }

    if (res?.data && res.data.isLogin) {
      return {
        isLogin: true,
        mid: res.data.mid,
        uname: res.data.uname,
        face: res.data.face,
        money: res.data.money,
        level: res.data.level_info?.current_level,
        vipType: res.data.vipType,
        vipStatus: res.data.vipStatus,
        vipDueDate: res.data.vipDueDate
      }
    }
  } catch (err) {
    log.warn('Failed to fetch nav profile', { error: String(err) })
  }

  return { isLogin: false }
}

/**
 * Generate Bilibili QR code and base64 PNG data URL for scanning.
 */
export async function generateQrCode(client: BiliClient): Promise<QrCodeGenerateResult> {
  const url =
    'https://passport.bilibili.com/x/passport-login/web/qrcode/generate?source=main-fe-header'
  const raw = await client.rawRequest(url, { method: 'GET' })
  const res = raw as {
    code?: number
    data?: {
      url?: string
      qrcode_key?: string
    }
  }

  if (res?.code !== 0 || !res?.data?.url || !res?.data?.qrcode_key) {
    throw new Error('获取二维码失败')
  }

  const qrUrl = res.data.url
  const qrcode_key = res.data.qrcode_key
  const qrDataUrl = await QRCode.toDataURL(qrUrl, {
    margin: 2,
    width: 220,
    color: {
      dark: '#000000',
      light: '#ffffff'
    }
  })

  return {
    url: qrUrl,
    qrcode_key,
    qrDataUrl
  }
}

/**
 * Poll QR code login event state.
 */
export async function pollQrCode(client: BiliClient, qrcodeKey: string): Promise<QrCodePollResult> {
  const pollUrl = 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll'
  const resp = await client.rawRequestWithHeaders(pollUrl, {
    method: 'GET',
    params: {
      qrcode_key: qrcodeKey,
      source: 'main-fe-header'
    }
  })

  const res = resp.data as {
    code?: number
    data?: {
      code?: number
      message?: string
      url?: string
      refresh_token?: string
    }
    message?: string
  }

  const code = res?.data?.code ?? res?.code ?? -1
  const message = res?.data?.message || res?.message || ''
  const result: QrCodePollResult = {
    code,
    message,
    url: res?.data?.url,
    refresh_token: res?.data?.refresh_token
  }

  if (code === QrCodeStatus.SUCCESS) {
    const cookieMap: Record<string, string> = {}
    for (const cookieStr of resp.setCookies) {
      const parts = cookieStr.split(';')
      const first = parts[0]?.trim()
      if (!first) continue
      const eqIdx = first.indexOf('=')
      if (eqIdx <= 0) continue
      const key = first.slice(0, eqIdx).trim()
      const val = first.slice(eqIdx + 1).trim()
      if (key && val) {
        cookieMap[key] = val
      }
    }

    let sessdata = cookieMap['SESSDATA'] || ''
    let biliJct = cookieMap['bili_jct'] || ''
    let dedeuserid = cookieMap['DedeUserID'] || cookieMap['dedeuserid'] || ''

    // If url contains parameters, parse them as well
    if (res?.data?.url) {
      try {
        const parsedUrl = new URL(res.data.url)
        if (!sessdata) sessdata = parsedUrl.searchParams.get('SESSDATA') || ''
        if (!biliJct) biliJct = parsedUrl.searchParams.get('bili_jct') || ''
        if (!dedeuserid) dedeuserid = parsedUrl.searchParams.get('DedeUserID') || ''
      } catch {
        /* ignore url parse errors */
      }
    }

    const credOptions: Record<string, string | undefined> = {
      sessdata,
      bili_jct: biliJct,
      dedeuserid,
      buvid3: cookieMap['buvid3'],
      buvid4: cookieMap['buvid4'],
      ac_time_value: res?.data?.refresh_token
    }

    for (const [k, v] of Object.entries(cookieMap)) {
      if (
        !['sessdata', 'bili_jct', 'dedeuserid', 'buvid3', 'buvid4', 'ac_time_value'].includes(
          k.toLowerCase()
        )
      ) {
        credOptions[k] = v
      }
    }

    result.credential = new BiliCredential(credOptions)
    log.info('QR poll succeeded', {
      hasSessdata: result.credential.hasSessdata(),
      cookieKeys: Object.keys(cookieMap),
      dedeuserid
    })
  }

  return result
}
