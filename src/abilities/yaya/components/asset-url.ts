/**
 * 会话资产 URI（`yaya-asset://<会话>/<文件>`）→ 界面可直接加载的地址。
 * Electron 下原样返回（主进程注册了协议）；网页模式改写成 `/_p/yaya-asset/…`。
 */
export function assetUrl(uri: string): string {
  return window.cockpit.hostUrl(uri)
}
