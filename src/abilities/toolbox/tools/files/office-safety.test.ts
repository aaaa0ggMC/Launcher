import assert from 'node:assert/strict'
import { test } from 'node:test'
import JSZip from 'jszip'
import { checkOfficePackage } from './office-safety'

async function document(name: string, xml: string): Promise<Buffer> {
  const zip = new JSZip()
  zip.file(name, xml)
  return zip.generateAsync({ type: 'nodebuffer' })
}
test('Office conversion refuses external references, encoded targets and macros before opening', async () => {
  for (const xml of [
    '<Relationships><Relationship TargetMode="External" Target="https://example.com/a.png"/></Relationships>',
    '<Relationships><Relationship TargetMode="&#69;xternal" Target="file:///etc/passwd"/></Relationships>',
    '<office:document xmlns:office="a" xmlns:xlink="b"><image xlink:href="https://example.com/a.png"/></office:document>',
    '<!DOCTYPE a [<!ENTITY x SYSTEM "file:///etc/passwd">]><a>&x;</a>'
  ])
    await assert.rejects(checkOfficePackage(await document('content.xml', xml)))
  await assert.rejects(checkOfficePackage(await document('word/vbaProject.bin', 'macro')))
  await checkOfficePackage(
    await document('content.xml', '<document><text>Local content only</text></document>')
  )
})
