import { defineAsyncComponent } from 'vue'
import type { Ability } from '../../main/ui/ability'

/**
 * 设备发现 —— 局域网里的 Launcher 互相发现（UDP 广播 + 共享密码验证）。
 * 页面只读展示；真正的扫描在常驻后台作业 discoverer.scan 里跑，可经
 * 设置 → 开机服务 登记为开机自启（默认关）。
 */
export default {
  id: 'discoverer',
  name: '设备发现',
  icon: 'gi:discoverer',
  category: '网络',
  keepAlive: false,
  component: defineAsyncComponent(() => import('./View.vue')),
  settings: [
    {
      key: 'discoverer',
      label: '设备发现',
      icon: 'mdi-lan-connect',
      description: '设备显示名、广播周期与端口、验证共享密码',
      keywords: ['设备发现', '局域网', 'discover', 'lan', 'udp', '广播', '验证', 'verify'],
      items: [
        {
          key: 'discoverer',
          label: '设备发现',
          icon: 'mdi-lan-connect',
          description: '本机在局域网里显示的名字与报文参数',
          keywords: ['设备名', '名字', '端口', '周期', '广播', '验证', '密码'],
          fullWidth: true,
          component: defineAsyncComponent(() => import('./items/DiscovererSettings.vue'))
        }
      ]
    }
  ]
} satisfies Ability
