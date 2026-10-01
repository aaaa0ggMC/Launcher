/** Read dimensions before allocating decoded pixels. No decoding or I/O. */
export function imageDimensions(data: Buffer): [number, number] {
  if (
    data.length >= 24 &&
    data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    return [data.readUInt32BE(16), data.readUInt32BE(20)]
  }
  if (data.length >= 10 && /^GIF8[79]a$/.test(data.subarray(0, 6).toString('ascii'))) {
    return [data.readUInt16LE(6), data.readUInt16LE(8)]
  }
  if (data.length >= 26 && data.subarray(0, 2).toString('ascii') === 'BM') {
    const header = data.readUInt32LE(14)
    if (header === 12) return [data.readUInt16LE(18), data.readUInt16LE(20)]
    if (header >= 40) return [data.readInt32LE(18), Math.abs(data.readInt32LE(22))]
  }
  if (data.length >= 4 && data[0] === 255 && data[1] === 216) {
    let offset = 2
    while (offset + 3 < data.length) {
      if (data[offset++] !== 255) break
      while (data[offset] === 255) offset++
      const marker = data[offset++]
      if (marker === 217 || marker === 218) break
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue
      if (offset + 2 > data.length) break
      const length = data.readUInt16BE(offset)
      if (length < 2 || offset + length > data.length) break
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
        if (length < 7) break
        return [data.readUInt16BE(offset + 5), data.readUInt16BE(offset + 3)]
      }
      offset += length
    }
  }
  throw new Error('图片格式无效或不支持；支持 PNG / JPEG / GIF（首帧）/ BMP')
}
