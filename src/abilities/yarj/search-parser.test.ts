import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Photo } from './types'
import { hasAdvancedSyntax, filterPhotosWithQuery } from './search-parser'

const mockPhotos: Photo[] = [
  {
    id: 1,
    path: '/photos/trip/img_001.jpg',
    root: '/photos/trip',
    taken_at: '2025-06-10T08:00:00',
    width: 4000,
    height: 3000,
    gps_lat: 39.9042,
    gps_lon: 116.4074,
    gps_alt: 50,
    camera_make: 'Sony',
    camera_model: 'ILCE-7M4',
    lens_model: 'FE 24-70mm F2.8 GM II',
    iso: 100,
    f_number: 2.8,
    focal_length: 35,
    appendix: {
      tags: ['风景', '城市', '旅行'],
      city: '北京',
      country: '中国',
      formatted_address: '北京市东城区故宫博物院',
      comment: '故宫角楼日落 text and love'
    }
  },
  {
    id: 2,
    path: '/photos/trip/img_002.jpg',
    root: '/photos/trip',
    taken_at: '2025-06-10T09:00:00',
    width: 4000,
    height: 3000,
    gps_lat: null,
    gps_lon: null,
    gps_alt: null,
    camera_make: 'Xiaomi',
    camera_model: '14 Ultra',
    iso: 1600,
    f_number: 1.8,
    focal_length: 23,
    gps_guess: {
      lat: 39.91,
      lon: 116.41,
      distanceM: 1200,
      timeDiffSeconds: 3600,
      prevPath: '/photos/trip/img_001.jpg',
      nextPath: '/photos/trip/img_003.jpg',
      prevTakenAt: '2025-06-10T08:00:00',
      nextTakenAt: '2025-06-10T10:00:00'
    },
    appendix: {
      tags: ['夜景', '人像'],
      city: '北京',
      country: '中国',
      comment: '街头抓拍 love and peace'
    }
  },
  {
    id: 3,
    path: '/photos/trip/video_003.mp4',
    root: '/photos/trip',
    taken_at: '2025-06-10T10:00:00',
    width: 1920,
    height: 1080,
    gps_lat: 31.2304,
    gps_lon: 121.4737,
    gps_alt: 60,
    camera_make: 'Apple',
    camera_model: 'iPhone 15 Pro',
    appendix: {
      tags: ['旅行', 'vlog'],
      city: '上海',
      country: '中国'
    }
  }
]

describe('Yarj Advanced Search Grammar', () => {
  it('identifies plain text search without advanced syntax', () => {
    assert.equal(hasAdvancedSyntax('text and love'), false)
    assert.equal(hasAdvancedSyntax('text or love'), false)
    assert.equal(hasAdvancedSyntax('北京 故宫'), false)

    assert.equal(hasAdvancedSyntax('"text and love"'), true)
    assert.equal(hasAdvancedSyntax(':guess_gps'), true)
    assert.equal(hasAdvancedSyntax(':tags("风景")'), true)
    assert.equal(hasAdvancedSyntax('(a or b)'), true)
  })

  it('matches plain text queries without treating bare words "and" / "or" as operators', () => {
    const resAnd = filterPhotosWithQuery(mockPhotos, 'text and love')
    assert.deepEqual(
      resAnd.map((p) => p.id),
      [1]
    )

    const resNone = filterPhotosWithQuery(mockPhotos, 'text or love')
    assert.equal(resNone.length, 0)
  })

  it('supports quotes for boolean combination: "text and love" or "love and peace"', () => {
    const res = filterPhotosWithQuery(mockPhotos, '"text and love" or "love and peace"')
    assert.deepEqual(
      res.map((p) => p.id),
      [1, 2]
    )
  })

  it('supports :guess_gps directive', () => {
    const res = filterPhotosWithQuery(mockPhotos, ':guess_gps')
    assert.deepEqual(
      res.map((p) => p.id),
      [2]
    )
  })

  it('supports :has_gps directive', () => {
    const res = filterPhotosWithQuery(mockPhotos, ':has_gps')
    assert.deepEqual(
      res.map((p) => p.id),
      [1, 3]
    )
  })

  it('supports :gps(long, lat, km) for radius searching, including guessed GPS', () => {
    // 北京中心附近 5km，应该匹配包含真实 GPS 的 1，以及大致猜测在王府井附近的 2
    const resBeijing = filterPhotosWithQuery(mockPhotos, ':gps(116.4074, 39.9042, 5)')
    assert.deepEqual(
      resBeijing.map((p) => p.id),
      [1, 2]
    )

    // 上海附近 5km，匹配 3
    const resShanghai = filterPhotosWithQuery(mockPhotos, ':gps(121.47, 31.23, 5km)')
    assert.deepEqual(
      resShanghai.map((p) => p.id),
      [3]
    )
  })

  it('supports :tags with boolean expressions and handles trailing or gracefully', () => {
    const res1 = filterPhotosWithQuery(mockPhotos, ':tags("风景" and "城市")')
    assert.deepEqual(
      res1.map((p) => p.id),
      [1]
    )

    const res2 = filterPhotosWithQuery(mockPhotos, ':tags("风景" or "夜景")')
    assert.deepEqual(
      res2.map((p) => p.id),
      [1, 2]
    )

    // Trailing or while typing
    const resTrailing = filterPhotosWithQuery(mockPhotos, ':tags("风景" or )')
    assert.deepEqual(
      resTrailing.map((p) => p.id),
      [1]
    )
  })

  it('supports :camera and negation not :video', () => {
    const resSony = filterPhotosWithQuery(mockPhotos, ':camera("Sony")')
    assert.deepEqual(
      resSony.map((p) => p.id),
      [1]
    )

    const resNoVideo = filterPhotosWithQuery(mockPhotos, ':has_gps and not :video')
    assert.deepEqual(
      resNoVideo.map((p) => p.id),
      [1]
    )
  })

  it('supports EXIF comparisons like :iso and :f', () => {
    const resIso = filterPhotosWithQuery(mockPhotos, ':iso(> 800)')
    assert.deepEqual(
      resIso.map((p) => p.id),
      [2]
    )

    const resAperture = filterPhotosWithQuery(mockPhotos, ':f(<= 2.0)')
    assert.deepEqual(
      resAperture.map((p) => p.id),
      [2]
    )
  })

  it('supports combined directive and text search', () => {
    const res = filterPhotosWithQuery(mockPhotos, '故宫 :camera("Sony")')
    assert.deepEqual(
      res.map((p) => p.id),
      [1]
    )
  })
})
