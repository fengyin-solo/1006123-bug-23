/**
 * 跨模块共用的业务规则：一条记录算不算「待处理」「异常」，隐患等级怎么归一。
 * 数据层迁移、服务层写动作、看板读数都从这里取口径，避免各处各写一套导致对不上。
 */
import type { EntryRow, ModuleMeta } from './types'

// 命中这些状态即视为异常态（红色标记 / 看板异常量），与具体模块解耦。
const ABNORMAL_STATUSES = new Set([
  '待整改',
  '已返工',
  '已补浆',
  '已滞留',
  '预警',
  '报警',
  '超限',
  '待更换',
  '已废弃',
  '故障',
  '已延期',
  '不合格',
  '已停工',
])

// 各模块最后一个状态即终态：终态不算待处理，其余一律算待处理。
export function isPendingStatus(meta: ModuleMeta, status: string): boolean {
  return status !== meta.statuses[meta.statuses.length - 1]
}

export function isAbnormalStatus(status: string): boolean {
  return ABNORMAL_STATUSES.has(status)
}

// 规范化一行的派生标记：pending / abnormal 永远跟随当前状态，不允许残留旧状态的值。
export function normalizeFlags(meta: ModuleMeta, row: EntryRow): EntryRow {
  const status = String(row.status)
  return { ...row, pending: isPendingStatus(meta, status), abnormal: isAbnormalStatus(status) }
}

// 隐患等级归一：巡检记录与班组待办两边一致使用这套取值。
// 存量数据里的自由文本按关键字折算；认不出来的不强行拔高，按一般隐患处理。
const LEVEL_ALIASES: Array<[string, string[]]> = [
  ['重大隐患', ['重大', '特别重大', '一级']],
  ['较大隐患', ['较大', '严重', '二级']],
  ['一般隐患', ['一般', '三级', '普通', '']],
]

export function normalizeHazardLevel(value: unknown): string {
  const text = String(value ?? '').trim()
  for (const [canonical, aliases] of LEVEL_ALIASES) {
    if (aliases.some((alias) => alias !== '' && text.includes(alias))) {
      return canonical
    }
  }
  return '一般隐患'
}
