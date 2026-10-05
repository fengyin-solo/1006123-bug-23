import { defineStore } from 'pinia'

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: '张工',
    role: '巡检负责人',
    region: '盾构A区',
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
    // 切换当前值班人：用于核对「只有本区域巡检负责人能派发整改」。
    setIdentity(operator: string, role: string, region: string) {
      this.operator = operator
      this.role = role
      this.region = region
    },
  },
})
