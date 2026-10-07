/**
 * speech 插件接口层的单测：假 fetch，不联网、不读写用户目录。
 */
import assert from 'node:assert/strict'
import { after, it } from 'node:test'
import {
  __setSpeechFetchForTest,
  asrSettings,
  audioExtOf,
  multipart,
  synthesize,
  transcribe,
  ttsSettings
} from './service'

after(() => __setSpeechFetchForTest(null))

it('synthesize：POST /audio/speech，带密钥与参数，返回音频字节', async () => {
  let seen: { url: string; init: RequestInit } | null = null
  __setSpeechFetchForTest(async (url, init) => {
    seen = { url, init }
    return new Response(new Uint8Array([1, 2, 3]), { status: 200 })
  })
  const s = ttsSettings({
    tts_base_url: 'https://x.test/v1/',
    tts_api_key: 'k',
    tts_model: 'm',
    tts_voice: 'v',
    tts_format: 'bogus'
  })
  const buf = await synthesize(s, '你好')
  assert.deepEqual([...buf], [1, 2, 3])
  assert.equal(seen!.url, 'https://x.test/v1/audio/speech')
  const body = JSON.parse(String(seen!.init.body))
  assert.deepEqual(body, { model: 'm', input: '你好', voice: 'v', response_format: 'mp3' })
  assert.equal((seen!.init.headers as Record<string, string>).Authorization, 'Bearer k')
})

it('synthesize：HTTP 错误带状态码与响应片段', async () => {
  __setSpeechFetchForTest(async () => new Response('bad voice', { status: 400 }))
  const s = ttsSettings({ tts_base_url: 'https://x.test', tts_model: 'm', tts_voice: 'v' })
  await assert.rejects(synthesize(s, 'a'), /HTTP 400 — bad voice/)
})

it('transcribe：multipart 上传，读 JSON 的 text；纯文本响应也认', async () => {
  let body = ''
  let type = ''
  __setSpeechFetchForTest(async (_url, init) => {
    body = Buffer.from(init.body as Uint8Array).toString('latin1')
    type = (init.headers as Record<string, string>)['Content-Type']
    return new Response(JSON.stringify({ text: ' 你好 ' }), { status: 200 })
  })
  const s = asrSettings({ asr_base_url: 'https://x.test/v1', asr_model: 'whisper-1' })
  assert.equal(await transcribe(s, Buffer.from('AUDIO'), 'audio/webm;codecs=opus'), '你好')
  assert.match(type, /^multipart\/form-data; boundary=/)
  assert.match(body, /name="model"\r\n\r\nwhisper-1\r\n/)
  assert.match(body, /filename="speech\.webm"/)
  assert.ok(!body.includes('name="language"'), '空字段不发送')

  __setSpeechFetchForTest(async () => new Response('plain words', { status: 200 }))
  assert.equal(await transcribe(s, Buffer.from('A'), 'audio/mp4'), 'plain words')
})

it('audioExtOf / multipart 边界', () => {
  assert.equal(audioExtOf('audio/ogg;codecs=opus'), 'ogg')
  assert.equal(audioExtOf('audio/mp4'), 'm4a')
  assert.equal(audioExtOf(''), 'webm')
  const { body, contentType } = multipart(
    { a: '1' },
    { name: 'f.wav', mime: 'audio/wav', data: Buffer.from('x') }
  )
  const boundary = contentType.split('boundary=')[1]
  assert.ok(body.toString().endsWith(`--${boundary}--\r\n`))
})
