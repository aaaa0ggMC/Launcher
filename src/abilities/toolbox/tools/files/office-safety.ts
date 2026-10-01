import JSZip from 'jszip'
import { XMLParser, XMLValidator } from 'fast-xml-parser'

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  parseTagValue: false
})
const REFUSED = '文档包含宏或外部引用；为保证离线，请嵌入资源并移除宏后重试'
/** Reject active references before handing an Office package to an external reader. */
export async function checkOfficePackage(buffer: Buffer): Promise<void> {
  const zip = await JSZip.loadAsync(buffer)
  const files = Object.values(zip.files)
  if (files.length > 6000) throw new Error('文档内部文件过多')
  let expanded = 0
  let xmlBytes = 0
  for (const file of files) {
    const size =
      (file as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0
    expanded += size
    if (expanded > 128 * 1024 * 1024) throw new Error('文档解压后超过 128MB')
    if (/vbaproject|(^|\/)(basic|scripts|externallinks|embeddings)\//i.test(file.name))
      throw new Error(REFUSED)
    if (file.dir || !/\.(xml|rels)$/i.test(file.name)) continue
    if (size > 8 * 1024 * 1024 || (xmlBytes += size) > 32 * 1024 * 1024)
      throw new Error('文档 XML 超过处理上限')
    const xml = await file.async('string')
    if (/<!DOCTYPE|<!ENTITY/i.test(xml) || /\b(WEBSERVICE|DDE)\s*\(/i.test(xml))
      throw new Error(REFUSED)
    if (XMLValidator.validate(xml) !== true) throw new Error('文档 XML 损坏')
    const queue: unknown[] = [parser.parse(xml)]
    let visited = 0
    while (queue.length) {
      if (++visited > 250000) throw new Error('文档结构过于复杂')
      const value = queue.pop()
      if (!value || typeof value !== 'object') continue
      for (const [key, child] of Object.entries(value)) {
        const lower = key.toLowerCase()
        if (lower === '@targetmode' && String(child).toLowerCase() === 'external')
          throw new Error(REFUSED)
        if (lower === '@target' || lower.endsWith(':href')) {
          const reference = String(child).trim()
          if (/^(?:[a-z][\w+.-]*:|[\\/]{1,2}|\.\.[\\/])/i.test(reference)) throw new Error(REFUSED)
        }
        if (
          /^(?:office:scripts|script:event-listener|table:cell-range-source|db:connection-resource)$/i.test(
            key
          )
        )
          throw new Error(REFUSED)
        queue.push(child)
      }
    }
  }
}
/** Values verified against LibreOffice's configuration schemas; Calc never=1, Writer never=2. */
export function officeProfile(): string {
  const props: Array<[string, string, string]> = [
    ['/org.openoffice.Office.Common/Security/Scripting', 'MacroSecurityLevel', '3'],
    ['/org.openoffice.Office.Common/Security/Scripting', 'DisableMacrosExecution', 'true'],
    ['/org.openoffice.Office.Calc/Content/Update', 'Link', '1'],
    ['/org.openoffice.Office.Writer/Content/Update', 'Link', '2'],
    ['/org.openoffice.Office.Common/Misc', 'ExperimentalMode', 'false']
  ]
  return (
    '<?xml version="1.0" encoding="UTF-8"?><oor:items xmlns:oor="http://openoffice.org/2001/registry">' +
    props
      .map(
        ([path, name, value]) =>
          `<item oor:path="${path}"><prop oor:name="${name}" oor:op="fuse"><value>${value}</value></prop></item>`
      )
      .join('') +
    '</oor:items>'
  )
}
