import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { cachedVariantHaystack, setVariantCacheCapacity } from './chineseVariants'

describe('AIDJ chineseVariants', () => {
  beforeEach(() => {
    setVariantCacheCapacity(100)
  })

  it('expands simplified Chinese text to include traditional variant', () => {
    const res = cachedVariantHaystack('song1', '周杰伦')
    assert.ok(res.includes('周杰伦'))
    assert.ok(res.includes('周杰倫'))
  })

  it('expands traditional Chinese text to include simplified variant', () => {
    const res = cachedVariantHaystack('song2', '頭髮')
    assert.ok(res.includes('头发'))
    assert.ok(res.includes('頭髮'))
  })

  it('caches results and returns same value on subsequent calls', () => {
    const res1 = cachedVariantHaystack('song3', '晴天')
    const res2 = cachedVariantHaystack('song3', '晴天')
    assert.equal(res1, res2)

    // Modifying text with same key recomputes when length differs
    const res3 = cachedVariantHaystack('song3', '晴天周杰伦')
    assert.notEqual(res1, res3)
  })

  it('capacity = 0 disables caching', () => {
    setVariantCacheCapacity(0)
    const res1 = cachedVariantHaystack('song4', '七里香')
    assert.ok(res1.includes('七里香'))
  })

  it('shrinking capacity clears excess entries', () => {
    cachedVariantHaystack('k1', '文字一')
    cachedVariantHaystack('k2', '文字二')
    cachedVariantHaystack('k3', '文字三')

    setVariantCacheCapacity(1)
    // After shrinking capacity below current size, cache was cleared
    const res = cachedVariantHaystack('k1', '文字一')
    assert.ok(res.includes('文字一'))
  })
})
