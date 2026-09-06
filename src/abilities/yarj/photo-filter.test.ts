import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  getPhotoFieldValue,
  parseValuesList,
  evalFilterRule,
  filterPhotosByRules
} from './photo-filter'
import type { Photo, PhotoFilterRule } from './types'

function makeTestPhoto(partial?: Partial<Photo>): Photo {
  return {
    id: 1,
    path: '/media/photos/IMG_001.jpg',
    root: '/media/photos',
    file_size: 1024000,
    width: 4000,
    height: 3000,
    orientation: 1,
    taken_at: '2024-05-01 12:00:00',
    camera_make: 'SONY',
    camera_model: 'ILCE-7M4',
    lens_model: 'FE 24-70mm F2.8 GM II',
    focal_length: 35,
    f_number: 2.8,
    exposure_time: '1/250',
    iso: 400,
    gps_lat: 30.5,
    gps_lon: 114.4,
    gps_alt: 25,
    hash: 'abc123hash',
    appendix: {
      tags: ['风景', '湖畔', '晴天'],
      comment: '春季郊游拍的美景',
      ai_generated: {
        type: 'Scenery',
        brief: 'A beautiful lake landscape in spring',
        ocr: ''
      }
    },
    ...partial
  }
}

describe('Yarj Photo Filter Engine', () => {
  test('getPhotoFieldValue retrieves top-level and nested fields accurately', () => {
    const photo = makeTestPhoto()

    // Top-level
    assert.strictEqual(getPhotoFieldValue(photo, 'path'), '/media/photos/IMG_001.jpg')
    assert.strictEqual(getPhotoFieldValue(photo, 'camera_model'), 'ILCE-7M4')
    assert.strictEqual(getPhotoFieldValue(photo, 'iso'), 400)

    // Appendix direct or deep
    assert.deepStrictEqual(getPhotoFieldValue(photo, 'tags'), ['风景', '湖畔', '晴天'])
    assert.deepStrictEqual(getPhotoFieldValue(photo, 'appendix.tags'), ['风景', '湖畔', '晴天'])
    assert.strictEqual(getPhotoFieldValue(photo, 'comment'), '春季郊游拍的美景')

    // AI generated shortcut & deep
    assert.strictEqual(getPhotoFieldValue(photo, 'ai_generated.type'), 'Scenery')
    assert.strictEqual(
      getPhotoFieldValue(photo, 'aigenerated.brief'),
      'A beautiful lake landscape in spring'
    )

    // Non-existent
    assert.strictEqual(getPhotoFieldValue(photo, 'non_existent_key'), undefined)
  })

  test('parseValuesList parses comma-separated, newline-separated, and JSON arrays', () => {
    // Comma
    assert.deepStrictEqual(parseValuesList('Document, Blackboard, Screenshot'), [
      'Document',
      'Blackboard',
      'Screenshot'
    ])
    // Chinese comma & newline
    assert.deepStrictEqual(parseValuesList('风景，晴天\n日落；夜景'), [
      '风景',
      '晴天',
      '日落',
      '夜景'
    ])
    // JSON array
    assert.deepStrictEqual(parseValuesList('["Portrait", "Pet"]'), ['Portrait', 'Pet'])
    // Empty
    assert.deepStrictEqual(parseValuesList(''), [])
  })

  test('evalFilterRule evaluates equality and inclusion operators', () => {
    const photo = makeTestPhoto()

    // in / not_in (scalar)
    const ruleIn: PhotoFilterRule = {
      id: '1',
      field: 'ai_generated.type',
      operator: 'in',
      value: 'Scenery, Architecture',
      enabled: true
    }
    assert.strictEqual(evalFilterRule(photo, ruleIn), true)

    const ruleNotIn: PhotoFilterRule = {
      id: '2',
      field: 'ai_generated.type',
      operator: 'not_in',
      value: 'Document, Screenshot',
      enabled: true
    }
    assert.strictEqual(evalFilterRule(photo, ruleNotIn), true)

    // in with array field (tags)
    const ruleTagIn: PhotoFilterRule = {
      id: '3',
      field: 'appendix.tags',
      operator: 'in',
      value: '湖畔, 海滩',
      enabled: true
    }
    assert.strictEqual(evalFilterRule(photo, ruleTagIn), true)

    // equals / not_equals
    const ruleEq: PhotoFilterRule = {
      id: '4',
      field: 'camera_make',
      operator: 'equals',
      value: 'sony',
      enabled: true
    }
    assert.strictEqual(evalFilterRule(photo, ruleEq), true)

    const ruleNotEq: PhotoFilterRule = {
      id: '5',
      field: 'camera_make',
      operator: 'not_equals',
      value: 'canon',
      enabled: true
    }
    assert.strictEqual(evalFilterRule(photo, ruleNotEq), true)
  })

  test('evalFilterRule evaluates contains, is_empty, and numerical comparisons', () => {
    const photo = makeTestPhoto()

    // contains
    const ruleContains: PhotoFilterRule = {
      id: '1',
      field: 'comment',
      operator: 'contains',
      value: '春季',
      enabled: true
    }
    assert.strictEqual(evalFilterRule(photo, ruleContains), true)

    // is_empty / is_not_empty
    const ruleNotEmpty: PhotoFilterRule = {
      id: '2',
      field: 'gps_lat',
      operator: 'is_not_empty',
      value: '',
      enabled: true
    }
    assert.strictEqual(evalFilterRule(photo, ruleNotEmpty), true)

    const ruleEmpty: PhotoFilterRule = {
      id: '3',
      field: 'gps_lat',
      operator: 'is_empty',
      value: '',
      enabled: true
    }
    assert.strictEqual(evalFilterRule(photo, ruleEmpty), false)

    // Numerical gt / lt
    const ruleIsoGt: PhotoFilterRule = {
      id: '4',
      field: 'iso',
      operator: 'gt',
      value: '200',
      enabled: true
    }
    assert.strictEqual(evalFilterRule(photo, ruleIsoGt), true)

    const ruleIsoLt: PhotoFilterRule = {
      id: '5',
      field: 'iso',
      operator: 'lt',
      value: '100',
      enabled: true
    }
    assert.strictEqual(evalFilterRule(photo, ruleIsoLt), false)
  })

  test('filterPhotosByRules combines active rules in AND logic', () => {
    const photo1 = makeTestPhoto({ id: 1, camera_make: 'SONY', iso: 400 })
    const photo2 = makeTestPhoto({ id: 2, camera_make: 'Canon', iso: 100 })
    const photo3 = makeTestPhoto({ id: 3, camera_make: 'SONY', iso: 800 })

    const rules: PhotoFilterRule[] = [
      {
        id: 'r1',
        field: 'camera_make',
        operator: 'equals',
        value: 'SONY',
        enabled: true
      },
      {
        id: 'r2',
        field: 'iso',
        operator: 'gt',
        value: '500',
        enabled: true
      }
    ]

    const filtered = filterPhotosByRules([photo1, photo2, photo3], rules)
    assert.strictEqual(filtered.length, 1)
    assert.strictEqual(filtered[0].id, 3)

    // Disabled rule is ignored
    rules[1].enabled = false
    const filtered2 = filterPhotosByRules([photo1, photo2, photo3], rules)
    assert.strictEqual(filtered2.length, 2)
  })
})
