/** Parent-only opt-in checks; never run external tools against real user data. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { execute } from './service'
import { withToolSignal } from '../../execution-context'
import type { ToolFile } from '../../types'

const enabled = process.env.TOOLBOX_EXTERNAL_TESTS === '1'
if (enabled) assert.ok(homedir().startsWith('/tmp/'), 'integration HOME must be temporary')
const file = (name: string, data: Buffer): ToolFile => ({
  name,
  mime: 'application/octet-stream',
  base64: data.toString('base64')
})

test(
  'real qpdf/Poppler/LibreOffice round trip, Unicode passwords and local exports',
  { skip: !enabled },
  async () => {
    const pdf = await PDFDocument.create()
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    pdf.addPage().drawText('Local toolbox integration', { font })
    const input = file('sample.pdf', Buffer.from(await pdf.save()))
    const password = 'local-测试\n@-' // newline and @- cannot inject qpdf options
    const encrypted = await execute('pdf-encrypt', { file: input, password })
    assert.equal(encrypted.ok, true, encrypted.error)
    const decrypted = await execute('pdf-decrypt', { file: encrypted.files![0], password })
    assert.equal(decrypted.ok, true, decrypted.error)
    assert.equal(
      (await PDFDocument.load(Buffer.from(decrypted.files![0].base64, 'base64'))).getPageCount(),
      1
    )
    const wrong = await execute('pdf-decrypt', { file: encrypted.files![0], password: 'wrong' })
    assert.equal(wrong.ok, false)
    assert.ok(!wrong.error?.includes(password))
    const text = await execute('pdf-to-text', { file: input })
    assert.equal(text.ok, true, text.error)
    assert.match(text.text ?? '', /Local toolbox integration/)
    const images = await execute('pdf-to-images', { file: input, dpi: 72, maxPages: 1 })
    assert.equal(images.ok, true, images.error)
    assert.equal(images.files?.length, 1)
    const docx = await execute('text-to-word', { text: 'Local office conversion' })
    const converted = await execute('document-convert', { file: docx.files![0], target: 'pdf' })
    assert.equal(converted.ok, true, converted.error)
    assert.equal(
      (await PDFDocument.load(Buffer.from(converted.files![0].base64, 'base64'))).getPageCount(),
      1
    )
  }
)

test(
  'real ffmpeg media conversion, metadata, cancellation and blocked HTTP playlist',
  { skip: !enabled },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'toolbox-media-test-'))
    try {
      const path = join(dir, 'sample.wav')
      const fixture = spawnSync('ffmpeg', [
        '-v',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=0.2',
        path
      ])
      assert.equal(fixture.status, 0)
      const input = file('sample.wav', await readFile(path))
      const converted = await execute('media-convert', { file: input, format: 'mp3' })
      assert.equal(converted.ok, true, converted.error)
      const info = await execute('media-info', { file: converted.files![0] })
      assert.equal(info.ok, true, info.error)
      const remote = await execute('media-info', {
        file: file(
          'playlist.m3u8',
          Buffer.from(
            '#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nhttps://example.invalid/secret.ts\n#EXT-X-ENDLIST\n'
          )
        )
      })
      assert.equal(remote.ok, false)
      const controller = new AbortController()
      controller.abort()
      const cancelled = await withToolSignal(controller.signal, () =>
        execute('media-info', { file: input })
      )
      assert.equal(cancelled.ok, false)
      assert.match(cancelled.error ?? '', /取消/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
)
