import assert from 'node:assert/strict'
import { it } from 'node:test'
import { WIDGET_FRAME_URI, widgetFrameResponse } from './frame'

it('外壳页：严格 CSP（无网络、沙箱）+ COEP；只认父窗口的 render 消息', async () => {
  const r = widgetFrameResponse()
  const csp = r.headers.get('Content-Security-Policy') ?? ''
  assert.match(csp, /default-src 'none'/)
  assert.match(csp, /sandbox allow-scripts/)
  assert.doesNotMatch(csp, /connect-src|allow-same-origin/)
  assert.equal(r.headers.get('Cross-Origin-Embedder-Policy'), 'credentialless')
  const html = await r.text()
  assert.match(html, /e\.source!==parent/)
  assert.match(html, /yaya-widget:ready/)
  // 内嵌的第二段脚本被转义，外壳页只有一个真正的 </script>
  assert.equal(html.split('</script>').length, 2)
  assert.equal(WIDGET_FRAME_URI, 'yaya-asset://.widget/frame')
})
