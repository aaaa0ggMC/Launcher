/**
 * HTML 小部件的沙箱外壳页（主进程提供，渲染端只拿到地址）。
 *
 * 为什么不用 srcdoc / blob: / data: iframe：这些「本地 scheme」文档会继承父页面的 CSP
 * （`script-src 'self'`），内联脚本一律被拦。所以外壳页走一个真正的 URL——复用 `yaya-asset`
 * 协议的保留地址 `yaya-asset://.widget/frame`（会话 id 不会以 `.` 开头），由它自己的响应头 CSP 约束：
 *  - `default-src 'none'`：没有网络（fetch / 外部脚本 / 图片 / 字体全部拦截），只放行内联脚本 / 样式
 *    与 data: / blob: 资源；`form-action 'none'`、`base-uri 'none'`；
 *  - CSP `sandbox allow-scripts` + iframe `sandbox="allow-scripts"`（不给 allow-same-origin）：
 *    不透明 origin，拿不到父页面、Cookie、存储，也不能弹窗 / 导航顶层窗口。
 * 外壳页收到父页面的 `yaya-widget:render` 消息后 document.write 小部件内容（CSP 保留），
 * 再注入一段主题变量与「上报内容高度」的脚本。
 */
export const WIDGET_FRAME_URI = 'yaya-asset://.widget/frame'

const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'media-src data: blob:',
  'font-src data:',
  "form-action 'none'",
  "base-uri 'none'",
  'sandbox allow-scripts'
].join('; ')

/** 写在小部件内容之后：主题变量放在 <head> 最前（小部件自己的样式可以覆盖），并上报高度 */
const AFTER = `<script>(function(){
var d=window.__yayaTheme||{};var s=document.createElement('style');
s.textContent=':root{color-scheme:'+d.scheme+';--yaya-fg:'+d.fg+';--yaya-bg:'+d.bg+';--yaya-primary:'+d.primary+'}html,body{margin:0;background:transparent;color:var(--yaya-fg);font:14px/1.5 system-ui,sans-serif}body{padding:12px 16px}';
var h=document.head||document.documentElement;h.insertBefore(s,h.firstChild);
var last=-1;function size(){var v=Math.ceil(Math.max(document.documentElement.scrollHeight,document.body?document.body.scrollHeight:0));if(v!==last){last=v;parent.postMessage({type:'yaya-widget:size',height:v},'*')}}
try{new ResizeObserver(size).observe(document.documentElement)}catch(e){}
addEventListener('load',size);setTimeout(size,0);setTimeout(size,300)
})()</script>`

const SHELL = `<!doctype html><html><head><meta charset="utf-8"></head><body><script>(function(){
var done=false;var AFTER=${JSON.stringify(AFTER).replace(/<\//g, '<\\/')};
function clean(v){return String(v||'').replace(/[^#0-9a-zA-Z(),.% -]/g,'').slice(0,40)}
addEventListener('message',function(e){
if(done||e.source!==parent||!e.data||e.data.type!=='yaya-widget:render')return;done=true;
var d=e.data;window.__yayaTheme={scheme:d.scheme==='light'?'light':'dark',fg:clean(d.fg),bg:clean(d.bg),primary:clean(d.primary)};
document.open();document.write(String(d.html||'')+AFTER);document.close()});
parent.postMessage({type:'yaya-widget:ready'},'*')})()</script></body></html>`

export function widgetFrameResponse(): Response {
  return new Response(SHELL, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': CSP,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
      // 网页模式的父页面带 COEP（credentialless）：嵌入的文档也要声明，否则加载被拦
      'Cross-Origin-Embedder-Policy': 'credentialless',
      'Cross-Origin-Resource-Policy': 'cross-origin'
    }
  })
}
