/**
 * speech 插件接口层的单测：假 fetch，不联网、不读写用户目录。
 */
import assert from 'node:assert/strict'
import { after, it } from 'node:test'
import {
  __setSpeechFetchForTest,
  asrMissing,
  engineOf,
  geminiAsrPrompt,
  parseMimoSse,
  pcm16ToWav,
  rateOfMime,
  ttsMissing,
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
    tts_engine: 'openai',
    tts_base_url: 'https://x.test/v1/',
    tts_api_key: 'k',
    tts_model: 'm',
    tts_voice: 'v',
    tts_format: 'bogus'
  })
  const out = await synthesize(s, '你好')
  assert.deepEqual([...out.data], [1, 2, 3])
  assert.equal(out.ext, 'mp3')
  assert.equal(seen!.url, 'https://x.test/v1/audio/speech')
  const body = JSON.parse(String(seen!.init.body))
  assert.deepEqual(body, { model: 'm', input: '你好', voice: 'v', response_format: 'mp3' })
  assert.equal((seen!.init.headers as Record<string, string>).Authorization, 'Bearer k')
})

it('synthesize：HTTP 错误带状态码与响应片段', async () => {
  __setSpeechFetchForTest(async () => new Response('bad voice', { status: 400 }))
  const s = ttsSettings({
    tts_engine: 'api',
    tts_base_url: 'https://x.test',
    tts_model: 'm',
    tts_voice: 'v'
  })
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
  const s = asrSettings({
    asr_engine: 'openai',
    asr_base_url: 'https://x.test/v1',
    asr_model: 'whisper-1'
  })
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

it('engineOf：旧值兼容，未知值回落 system；留空字段用服务商默认', () => {
  assert.equal(engineOf('browser'), 'system')
  assert.equal(engineOf('api'), 'openai')
  assert.equal(engineOf('nope'), 'system')
  const g = ttsSettings({ tts_engine: 'gemini' })
  assert.equal(g.baseUrl, 'https://generativelanguage.googleapis.com/v1beta')
  assert.equal(g.voice, 'Kore')
  assert.deepEqual(ttsMissing(g), ['API Key'])
  assert.deepEqual(ttsMissing(ttsSettings({ tts_engine: 'system' })), [])
  assert.equal(asrSettings({ asr_engine: 'mimo' }).model, 'mimo-v2.5-asr')
  assert.deepEqual(asrMissing(asrSettings({ asr_engine: 'mimo', asr_api_key: 'k' })), [])
})

it('MiMo TTS：chat/completions + audio，SSE 里的 PCM 拼成 24k WAV，风格放括号里', async () => {
  let seen: { url: string; init: RequestInit } | null = null
  const pcm1 = Buffer.from([1, 0, 2, 0])
  const pcm2 = Buffer.from([3, 0])
  const sse = [
    `data: ${JSON.stringify({ choices: [{ delta: { audio: { data: pcm1.toString('base64') } } }] })}`,
    'data: {"choices":[{"delta":{}}]}',
    `data: ${JSON.stringify({ choices: [{ delta: { audio: { data: pcm2.toString('base64') } } }] })}`,
    'data: [DONE]',
    ''
  ].join('\n')
  __setSpeechFetchForTest(async (url, init) => {
    seen = { url, init }
    return new Response(sse, { status: 200 })
  })
  const s = ttsSettings({ tts_engine: 'mimo', tts_api_key: 'mk', tts_instructions: '开心（磁性）' })
  const out = await synthesize(s, '你好')
  assert.equal(out.ext, 'wav')
  assert.equal(out.data.readUInt32LE(24), 24000)
  assert.deepEqual([...out.data.subarray(44)], [1, 0, 2, 0, 3, 0])
  assert.equal(seen!.url, 'https://api.xiaomimimo.com/v1/chat/completions')
  assert.equal((seen!.init.headers as Record<string, string>)['api-key'], 'mk')
  const body = JSON.parse(String(seen!.init.body))
  assert.equal(body.messages[0].content, '(开心 磁性)你好')
  assert.deepEqual(body.audio, { format: 'pcm16', voice: 'mimo_default' })
  assert.equal(body.stream, true)
  assert.equal(parseMimoSse('data: [DONE]').length, 0)
})

it('Gemini TTS：generateContent 要 AUDIO，L16 PCM 包成 WAV（采样率取自 mimeType）', async () => {
  let seen: { url: string; init: RequestInit } | null = null
  __setSpeechFetchForTest(async (url, init) => {
    seen = { url, init }
    return Response.json({
      candidates: [
        {
          content: {
            parts: [
              {
                inlineData: {
                  mimeType: 'audio/L16;codec=pcm;rate=16000',
                  data: Buffer.from([9, 9]).toString('base64')
                }
              }
            ]
          }
        }
      ]
    })
  })
  const s = ttsSettings({ tts_engine: 'gemini', tts_api_key: 'gk', tts_voice: 'Puck' })
  const out = await synthesize(s, 'hi')
  assert.equal(out.data.readUInt32LE(24), 16000)
  assert.equal(
    seen!.url,
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent'
  )
  assert.equal((seen!.init.headers as Record<string, string>)['x-goog-api-key'], 'gk')
  const body = JSON.parse(String(seen!.init.body))
  assert.deepEqual(body.generationConfig.responseModalities, ['AUDIO'])
  assert.equal(body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Puck')
  assert.equal(rateOfMime('audio/L16'), 24000)
})

it('MiMo ASR：input_audio data URL + asr_options，结果取 message.content', async () => {
  let body: Record<string, unknown> = {}
  __setSpeechFetchForTest(async (_url, init) => {
    body = JSON.parse(String(init.body))
    return Response.json({ choices: [{ message: { content: ' 你好世界 ' } }] })
  })
  const s = asrSettings({ asr_engine: 'mimo', asr_api_key: 'k', asr_language: 'zh' })
  assert.equal(await transcribe(s, Buffer.from('RIFF'), 'audio/wav'), '你好世界')
  const msg = (body.messages as { content: { input_audio: { data: string } }[] }[])[0]
  assert.ok(msg.content[0].input_audio.data.startsWith('data:audio/wav;base64,'))
  assert.deepEqual(body.asr_options, { language: 'zh' })
})

it('Gemini ASR：提示词 + inlineData，拼接 parts 的文字', async () => {
  let body: { contents: { parts: Record<string, unknown>[] }[] } = { contents: [] }
  __setSpeechFetchForTest(async (_url, init) => {
    body = JSON.parse(String(init.body))
    return Response.json({
      candidates: [{ content: { parts: [{ text: 'hello ' }, { text: 'world' }] } }]
    })
  })
  const s = asrSettings({ asr_engine: 'gemini', asr_api_key: 'k' })
  assert.equal(await transcribe(s, Buffer.from('RIFF'), 'audio/wav'), 'hello world')
  assert.equal((body.contents[0].parts[1].inlineData as { mimeType: string }).mimeType, 'audio/wav')
  assert.match(geminiAsrPrompt('ja', ''), /language "ja"/)
  assert.doesNotMatch(geminiAsrPrompt('auto', ''), /language/)
})

it('pcm16ToWav：头部字段正确', () => {
  const w = pcm16ToWav(Buffer.alloc(8), 22050, 2)
  assert.equal(w.toString('latin1', 0, 4), 'RIFF')
  assert.equal(w.readUInt16LE(22), 2)
  assert.equal(w.readUInt32LE(28), 22050 * 4)
  assert.equal(w.readUInt32LE(40), 8)
})
