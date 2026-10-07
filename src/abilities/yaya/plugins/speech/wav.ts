/**
 * 录音 → 16kHz 单声道 WAV（渲染端）。MiMo / Gemini 不认浏览器 MediaRecorder 录的 webm / ogg，
 * 先解码再重采样成 PCM16 WAV（16kHz：一分钟约 1.9MB，够语音识别用）。
 */

export const ASR_SAMPLE_RATE = 16000

/** Float32 采样（-1..1）→ PCM16 WAV 字节（纯函数，可单测） */
export function encodeWav16(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const buf = new ArrayBuffer(44 + samples.length * 2)
  const v = new DataView(buf)
  const text = (at: number, s: string): void => {
    for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i))
  }
  text(0, 'RIFF')
  v.setUint32(4, 36 + samples.length * 2, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, 1, true)
  v.setUint32(24, sampleRate, true)
  v.setUint32(28, sampleRate * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  text(36, 'data')
  v.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) {
    const x = Math.max(-1, Math.min(1, samples[i]))
    v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true)
  }
  return buf
}

/** 任意浏览器能解码的录音 → 16kHz 单声道 WAV */
export async function toWav16k(blob: Blob): Promise<Blob> {
  const ctx = new AudioContext()
  let decoded: AudioBuffer
  try {
    decoded = await ctx.decodeAudioData(await blob.arrayBuffer())
  } finally {
    void ctx.close().catch(() => {})
  }
  const length = Math.max(1, Math.ceil(decoded.duration * ASR_SAMPLE_RATE))
  const off = new OfflineAudioContext(1, length, ASR_SAMPLE_RATE)
  const src = off.createBufferSource()
  src.buffer = decoded
  src.connect(off.destination)
  src.start()
  const out = await off.startRendering()
  return new Blob([encodeWav16(out.getChannelData(0), ASR_SAMPLE_RATE)], { type: 'audio/wav' })
}
