/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/** 闭环结论投影到班组进场待办的一条记录：不另存一套，全部由巡检记录折算。 */
export type ClosureTodo = {
  id: number
  巡检编号: string
  巡检区域: string
  隐患等级: string
  闭环时间: string
  闭环结论: string
}

/** 动作执行人：只有本区域的巡检负责人能派发整改。 */
export type Actor = {
  name: string
  role: string
  region: string
}
