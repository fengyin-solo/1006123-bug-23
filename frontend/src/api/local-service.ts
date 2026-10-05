import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, commitSnapshot, listRows, resetRows, saveRows } from '@/data/local-store'
import type {
  ActionResult,
  Actor,
  ClosureTodo,
  EntryRow,
  ModuleMeta,
  OverviewResult,
  PageResult,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

const SAFETY_KEY = 'safety'
const SAFETY_STATUSES = ['待巡检', '已巡检', '待整改', '已闭环']
const HAZARD_LEVELS = ['一般', '较大', '重大']
const DEADLINE_DAYS: Record<string, number> = { 一般: 5, 较大: 3, 重大: 2 }

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function addDays(base: Date, days: number): string {
  const date = new Date(base.getTime())
  date.setDate(date.getDate() + days)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function stampNow(): string {
  const now = new Date()
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}`
  )
}

function failure(message: string): ActionResult {
  return { ok: false, message }
}

/** 按序号执行动作：跳级一律驳回，同时说明眼下停在哪。 */
function statusPosition(meta: ModuleMeta, status: string): number {
  return meta.statuses.indexOf(status)
}

/**
 * 统一动作入口：巡检状态、隐患等级、整改期限写在同一份快照里，
 * 任意一步落库失败整笔退回（commitSnapshot 会回滚内存），不会只清一半。
 */
export function runAction(key: string, id: number, action: string, actor?: Actor): ActionResult {
  const meta = moduleMeta(key)
  if (!meta.actionTargets[action]) {
    return failure(`${meta.entity}没有登记「${action}」这个动作`)
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return failure(`没有找到编号为 ${id} 的${meta.entity}`)
  }

  if (key === SAFETY_KEY) {
    return runSafetyAction(rows, index, action, actor)
  }

  const current = String(rows[index].status)
  const target = meta.actionTargets[action]
  if (current === target) {
    return failure(`${meta.entity}已经是「${target}」，不用重复操作`)
  }
  const currentPos = statusPosition(meta, current)
  const targetPos = statusPosition(meta, target)
  if (targetPos < 0 || (currentPos >= 0 && targetPos > currentPos + 1)) {
    return failure(
      `${meta.entity}当前停在「${current}」，不能跳级到「${target}」，请先执行上一环节`,
    )
  }
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    // 业务模块自有的状态字段（如「设备状态」）随通用状态同写，不再各写一套。
    [meta.fields[meta.fields.length - 1]]: target,
    pending: target !== meta.statuses[meta.statuses.length - 1],
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  try {
    saveRows(key, next)
  } catch {
    return failure('落库失败，本次操作已整笔回滚，请重试')
  }
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

/** 安全巡检专用流转：提交巡检 → 派发整改 → 确认闭环，按序推进，闭环幂等。 */
function runSafetyAction(
  rows: EntryRow[],
  index: number,
  action: string,
  actor?: Actor,
): ActionResult {
  const row = rows[index]
  const current = String(row.status)

  if (action === '提交巡检') {
    if (current !== '待巡检') {
      return failure(`巡检单当前停在「${current}」，提交巡检只能在「待巡检」环节执行`)
    }
    const target = '已巡检'
    const updated: EntryRow = {
      ...row,
      status: target,
      巡检状态: target,
      pending: true,
      abnormal: false,
      巡检日期: isDate(row['巡检日期']) ? row['巡检日期'] : addDays(new Date(), 0),
    }
    return commitSafety(rows, index, updated, '巡检已提交，等待派发整改')
  }

  if (action === '派发整改') {
    if (current === '已闭环') {
      return failure('该隐患已经闭环，不允许再次派发整改')
    }
    if (current === '待整改') {
      return failure(
        `巡检单当前停在「待整改」（整改期限 ${String(row['整改期限'] ?? '—')}），不能重复派发`,
      )
    }
    if (current !== '已巡检') {
      return failure(`巡检单当前停在「${current}」，还没到派发整改环节，跳级操作一律驳回`)
    }
    if (!actor || actor.role !== '巡检负责人') {
      return failure('只有本区域的巡检负责人能派发整改，当前值班人无权操作')
    }
    if (actor.region !== String(row['巡检区域'])) {
      return failure(
        `该隐患属于「${String(row['巡检区域'])}」，跨区域改动不收（当前负责人管区：${actor.region}）`,
      )
    }
    const level = normalizeLevel(row['隐患等级'])
    const target = '待整改'
    const updated: EntryRow = {
      ...row,
      status: target,
      巡检状态: target,
      pending: true,
      abnormal: true,
      隐患等级: level,
      整改期限: addDays(new Date(), DEADLINE_DAYS[level]),
    }
    return commitSafety(rows, index, updated, `整改已派发给本区域负责人，整改期限 ${updated['整改期限']}`)
  }

  if (action === '确认闭环') {
    // 重复点只认第一次：已经闭环的直接返回现状，不再多落一条闭环记录。
    if (current === '已闭环') {
      return {
        ok: true,
        message: `该隐患已于 ${String(row['闭环时间'] ?? '—')} 闭环，重复提交不重复记账`,
      }
    }
    if (current !== '待整改') {
      return failure(`巡检单当前停在「${current}」，必须先派发整改并整改完成才能确认闭环，跳级一律驳回`)
    }
    const level = normalizeLevel(row['隐患等级'])
    const target = '已闭环'
    const closedAt = stampNow()
    const updated: EntryRow = {
      ...row,
      // 巡检状态、隐患等级、整改期限收在同一份里一次写入。
      status: target,
      巡检状态: target,
      隐患等级: level,
      // 上一版残留的整改期限随闭环一笔清掉，不留旧日期。
      整改期限: '',
      闭环时间: closedAt,
      闭环结论: buildClosureConclusion(row, level, closedAt),
      pending: false,
      abnormal: false,
    }
    return commitSafety(rows, index, updated, `隐患已确认闭环，闭环时间 ${closedAt}`)
  }

  return failure(`巡检记录没有登记「${action}」这个动作`)
}

function isDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)
}

/** 隐患等级两边（巡检单/班组待办）以巡检记录为准：沿用既有读取方式，等级缺失时按一般隐患兜底。 */
function normalizeLevel(value: unknown): string {
  return HAZARD_LEVELS.includes(String(value)) ? String(value) : '一般'
}

function buildClosureConclusion(row: EntryRow, level: string, closedAt: string): string {
  const code = String(row['巡检编号'] ?? '')
  const problem = String(row['发现问题'] ?? '').trim()
  const suffix = problem ? `，整改内容：${problem}` : ''
  return `${level}隐患整改复验合格，确认闭环（${code}）${suffix}；闭环时间 ${closedAt}`
}

/** 巡检单整笔提交：落库失败由 commitSnapshot 回滚整份快照，调用方直接提示失败。 */
function commitSafety(
  rows: EntryRow[],
  index: number,
  updated: EntryRow,
  message: string,
): ActionResult {
  const next = [...rows]
  next[index] = updated
  try {
    commitSnapshot({ ...allRows(), [SAFETY_KEY]: next })
  } catch {
    return failure('落库失败，本次改动整笔回滚退回，巡检状态、隐患等级与整改期限均未改动，请重试')
  }
  return { ok: true, message }
}

/** 各状态巡检单条数：列表、统计卡、班组待办都读这一处，口径一致。 */
export function safetyStatusCounts(): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const status of SAFETY_STATUSES) {
    counts[status] = 0
  }
  for (const row of listRows(SAFETY_KEY)) {
    const status = String(row.status)
    counts[status] = (counts[status] ?? 0) + 1
  }
  return counts
}

/** 班组进场待办清单里的闭环条目：不另存一套，直接从巡检记录折算。 */
export function closureTodos(): ClosureTodo[] {
  return listRows(SAFETY_KEY)
    .filter((row) => String(row.status) === '已闭环')
    .map((row) => ({
      id: Number(row.id),
      巡检编号: String(row['巡检编号'] ?? ''),
      巡检区域: String(row['巡检区域'] ?? ''),
      隐患等级: normalizeLevel(row['隐患等级']),
      闭环时间: String(row['闭环时间'] ?? ''),
      闭环结论: String(row['闭环结论'] ?? ''),
    }))
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
