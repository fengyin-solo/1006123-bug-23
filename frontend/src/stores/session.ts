import { defineStore } from 'pinia'

import { setActor } from '@/api/local-service'

// 预置几个值班身份，便于验证跨区域派发的收口规则。
export const OPERATOR_PRESETS = [
  { operator: '东区巡检负责人', role: '巡检负责人', region: '东区' },
  { operator: '西区巡检负责人', role: '巡检负责人', region: '西区' },
  { operator: '值班管理员', role: '平台管理员', region: '' },
]

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: '值班管理员',
    role: '平台管理员',
    region: '',
    shiftLabel: '白班 08:00-20:00',
    scope: '盾构隧道掘进施工管理平台',
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    // 切换值班身份后同步给本地数据服务，派发整改的区域/角色校验以此为准。
    applyIdentity(identity: { operator: string; role: string; region: string }) {
      this.operator = identity.operator
      this.role = identity.role
      this.region = identity.region
      setActor({ name: identity.operator, role: identity.role, region: identity.region })
    },
  },
})
