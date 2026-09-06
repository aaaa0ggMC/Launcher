/**
 * yarj 地理编码与逆解析引擎 (Forward & Reverse Geocoding)
 *
 * 优先使用用户配置的 Google Geocoding API；
 * 若未配置或网络受阻，则平滑降级至 OpenStreetMap Nominatim 开源服务。
 */
import { makeLogger } from '../../main/process/logger'
import type { GeocodeResult, ReverseGeocodeResult, YarjConfig } from './types'

const log = makeLogger('yarj-geocoding')

export async function forwardGeocodeWithConfig(
  query: string,
  cfg: YarjConfig,
  lang?: string
): Promise<GeocodeResult[]> {
  const apiKey = cfg.googleApiKey?.trim()
  const targetLang = lang || cfg.mapLanguage || 'zh-CN'

  // 1. 如果配置了 Google API Key，优先使用 Google Geocoding API
  if (apiKey) {
    try {
      const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}&key=${apiKey}&language=${encodeURIComponent(targetLang)}`
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
      if (res.ok) {
        const json = (await res.json()) as {
          status: string
          results?: Array<{
            formatted_address: string
            geometry: { location: { lat: number; lng: number } }
            place_id?: string
          }>
        }
        if (json.status === 'OK' && Array.isArray(json.results) && json.results.length > 0) {
          return json.results.map((r) => ({
            formattedAddress: r.formatted_address,
            lat: r.geometry.location.lat,
            lon: r.geometry.location.lng,
            placeId: r.place_id,
            provider: 'google'
          }))
        }
      }
    } catch (err) {
      log.warn('google forward geocode failed, falling back', { error: String(err) })
    }
  }

  // 2. Fallback: OpenStreetMap Nominatim API
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=5&accept-language=${encodeURIComponent(targetLang)}`
    const res = await fetch(url, {
      headers: { 'User-Agent': 'LinuxCockpit/0.1.0' },
      signal: AbortSignal.timeout(8000)
    })
    if (res.ok) {
      const json = (await res.json()) as Array<{
        display_name: string
        lat: string
        lon: string
        place_id?: number
      }>
      if (Array.isArray(json)) {
        return json.map((r) => ({
          formattedAddress: r.display_name,
          lat: parseFloat(r.lat),
          lon: parseFloat(r.lon),
          placeId: r.place_id ? String(r.place_id) : undefined,
          provider: 'nominatim'
        }))
      }
    }
  } catch (err) {
    log.error('nominatim forward geocode failed', { error: String(err) })
  }

  return []
}

export async function reverseGeocodeWithConfig(
  lat: number,
  lon: number,
  cfg: YarjConfig,
  lang?: string
): Promise<ReverseGeocodeResult | null> {
  const apiKey = cfg.googleApiKey?.trim()
  const targetLang = lang || cfg.mapLanguage || 'zh-CN'

  // 1. 优先 Google Reverse Geocoding
  if (apiKey) {
    try {
      const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lon}&key=${apiKey}&language=${encodeURIComponent(targetLang)}`
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
      if (res.ok) {
        const json = (await res.json()) as {
          status: string
          results?: Array<{
            formatted_address: string
            place_id?: string
            address_components?: Array<{
              long_name: string
              types: string[]
            }>
          }>
        }
        if (json.status === 'OK' && Array.isArray(json.results) && json.results.length > 0) {
          const top = json.results[0]
          const cityComp = top.address_components?.find(
            (c) =>
              c.types.includes('locality') ||
              c.types.includes('administrative_area_level_2') ||
              c.types.includes('administrative_area_level_1')
          )
          const countryComp = top.address_components?.find((c) => c.types.includes('country'))
          return {
            formattedAddress: top.formatted_address,
            city: cityComp?.long_name,
            country: countryComp?.long_name,
            placeId: top.place_id,
            provider: 'google'
          }
        }
      }
    } catch (err) {
      log.warn('google reverse geocode failed, falling back', { error: String(err) })
    }
  }

  // 2. Fallback: OpenStreetMap Nominatim Reverse
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&accept-language=${encodeURIComponent(targetLang)}`
    const res = await fetch(url, {
      headers: { 'User-Agent': 'LinuxCockpit/0.1.0' },
      signal: AbortSignal.timeout(8000)
    })
    if (res.ok) {
      const json = (await res.json()) as {
        display_name?: string
        place_id?: number
        address?: {
          city?: string
          town?: string
          village?: string
          state?: string
          country?: string
        }
      }
      if (json.display_name) {
        return {
          formattedAddress: json.display_name,
          city:
            json.address?.city ||
            json.address?.town ||
            json.address?.village ||
            json.address?.state,
          country: json.address?.country,
          placeId: json.place_id ? String(json.place_id) : undefined,
          provider: 'nominatim'
        }
      }
    }
  } catch (err) {
    log.error('nominatim reverse geocode failed', { error: String(err) })
  }

  return null
}
