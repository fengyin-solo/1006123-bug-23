import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, commitTables, listRows, resetRows, saveRows } from '@/data/local-store'
import { isAbnormalStatus, isPendingStatus, normalizeHazardLevel } from '@/data/rules'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_VERBS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 当前操作人（角色与责任区域）：派发整改只认本区域的巡检负责人。
// 页面通过会话 store 调用 setActor 同步；默认是无责任区域的平台管理员，跨区域改动一律不收。
export type Actor = {
  name: string
  role: string
  region: string
}

let currentActor: Actor = { name: '值班管理员', role: '平台管理员', region: '' }

export function setActor(actor: Actor): void {
  currentActor = { ...actor }
}

export function getActor(): Actor {
  return { ...currentActor }
}

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

function todayText(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

// 动作是否落在状态机的相邻一档：跳级（含往回走）一律驳回，并说明眼下停在哪。
function adjacentTarget(meta: ModuleMeta, current: string, target: string): boolean {
  const index = meta.statuses.indexOf(current)
  if (index < 0) {
    return false
  }
  return meta.statuses[index + 1] === target
}

function applyFlags(meta: ModuleMeta, target: string, action: string): Pick<EntryRow, 'pending' | 'abnormal'> {
  const negative = NEGATIVE_VERBS.some((verb) => action.startsWith(verb))
  return {
    pending: isPendingStatus(meta, target),
    abnormal: negative || isAbnormalStatus(target),
  }
}

function addDays(base: Date, days: number): string {
  const date = new Date(base.getTime())
  date.setDate(date.getDate() + days)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

// 巡检状态、隐患等级与整改期限写在同一份里：派发整改时定等级与期限。
function dispatchRectification(meta: ModuleMeta, rows: EntryRow[], index: number): ActionResult {
  const row = rows[index]
  const code = String(row['巡检编号'] ?? row.id)
  const current = String(row.status)
  if (current === '待整改') {
    return { ok: false, message: `巡检记录${code}已是「待整改」，不用重复派发` }
  }
  if (current === '已闭环') {
    return { ok: false, message: `巡检记录${code}已闭环，不许再派发整改` }
  }
  // 跳级的一律驳回，同时说明眼下停在哪。
  if (!adjacentTarget(meta, current, '待整改')) {
    return { ok: false, message: `巡检记录${code}眼下停在「${current}」，不能跳到「待整改」` }
  }
  // 只有本区域的巡检负责人能派发整改，跨区域这类改动不收。
  const actor = getActor()
  if (actor.role !== '巡检负责人') {
    return { ok: false, message: `只有巡检负责人能派发整改，当前角色「${actor.role}」无权操作` }
  }
  const region = String(row['巡检区域'] ?? row['责任区域'] ?? '')
  if (!actor.region || actor.region !== region) {
    return { ok: false, message: `巡检记录${code}属「${region || '未分区'}」，非本区域负责人无权派发` }
  }
  // 派发时没有填期限的，按派发日起 7 天兜底；闭环时一并清掉，不残留旧日期。
  const deadline = String(row['整改期限'] ?? '').trim() || addDays(new Date(), 7)
  const updated: EntryRow = {
    ...row,
    status: '待整改',
    巡检状态: '待整改',
    隐患等级: normalizeHazardLevel(row['隐患等级']),
    整改期限: deadline,
    pending: true,
    abnormal: true,
  }
  const next = [...rows]
  next[index] = updated
  saveRows('safety', next)
  return { ok: true, message: `巡检记录${code}已派发整改，当前状态「待整改」，整改期限「${deadline}」` }
}

// 闭环收成一次动作：巡检状态、隐患等级、整改期限、闭环时间/结论与班组待办
// 在同一笔原子提交里完成；写不成功整笔退回，重复点只认头一笔的闭环时间。
function closeHazard(rows: EntryRow[], index: number, meta: ModuleMeta): ActionResult {
  const row = rows[index]
  const code = String(row['巡检编号'] ?? row.id)
  const current = String(row.status)
  if (current === '已闭环') {
    return {
      ok: false,
      message: `巡检记录${code}已于 ${String(row['闭环时间'] ?? '此前')} 闭环，只认头一笔闭环时间，不重复登记`,
    }
  }
  if (!adjacentTarget(meta, current, '已闭环')) {
    return { ok: false, message: `巡检记录${code}眼下停在「${current}」，不能跳到「已闭环」` }
  }
  const closedAt = String(row['闭环时间'] ?? '') || todayText()
  const conclusion = String(row['闭环结论'] ?? '') || '隐患整改完成，复验合格，准予闭环'
  const level = normalizeHazardLevel(row['隐患等级'])
  const updated: EntryRow = {
    ...row,
    status: '已闭环',
    巡检状态: '已闭环',
    隐患等级: level,
    整改期限: '', // 闭环后整改期限一并清掉，不许残留上一版日期
    闭环时间: closedAt,
    闭环结论: conclusion,
    pending: false,
    abnormal: false,
  }
  const nextSafety = [...rows]
  nextSafety[index] = updated

  // 闭环结论写到班组进场的待办清单；已闭环隐患数以巡检记录为准，待办只做镜像。
  const existingTodos = listRows('crew-todos')
  const todos = existingTodos.filter((todo) => String(todo['来源编号']) !== code)
  const nextId = existingTodos.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1
  const todo: EntryRow = {
    id: nextId,
    status: '待办',
    pending: false,
    abnormal: false,
    来源编号: code,
    巡检区域: String(row['巡检区域'] ?? ''),
    隐患等级: level,
    整改班组: String(row['整改班组'] ?? '责任班组'),
    闭环时间: closedAt,
    待办内容: `已闭环：${conclusion}`,
  }
  // 巡检表与班组待办两张表同一笔落库：失败整笔回滚，不许只清一半。
  commitTables({ safety: nextSafety, 'crew-todos': [...todos, todo] })
  return { ok: true, message: `巡检记录${code}已确认闭环，闭环时间「${closedAt}」` }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  // 落库失败一律整笔退回（commitTables 已回滚缓存），动作结果转成失败，不抛出半笔状态。
  try {
    return executeAction(meta, key, rows, index, action, target)
  } catch (error) {
    return {
      ok: false,
      message: `数据落库失败，已整笔回滚：${error instanceof Error ? error.message : '未知错误'}`,
    }
  }
}

function executeAction(
  meta: ModuleMeta,
  key: string,
  rows: EntryRow[],
  index: number,
  action: string,
  target: string,
): ActionResult {
  const row = rows[index]
  const current = String(row.status)

  // 安全巡检的派发整改 / 确认闭环有专门的收口规则。
  if (key === 'safety' && action === '派发整改') {
    return dispatchRectification(meta, rows, index)
  }
  if (key === 'safety' && action === '确认闭环') {
    return closeHazard(rows, index, meta)
  }

  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  // 其他业务面沿用同一套线性状态机：跳级（含往回走）一律驳回，并说明眼下停在哪。
  if (!adjacentTarget(meta, current, target)) {
    return { ok: false, message: `${meta.entity}眼下停在「${current}」，不能跳到「${target}」` }
  }
  const flags = applyFlags(meta, target, action)
  const updated: EntryRow = { ...row, status: target, ...flags }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

// 各状态条数：页面统计与图例统一用这份，读的是同一份数据。
export function statusSummary(key: string, statuses: string[]): { status: string; count: number }[] {
  const rows = listRows(key)
  return statuses.map((status) => ({
    status,
    count: rows.filter((row) => String(row.status) === status).length,
  }))
}

// 已闭环隐患的唯一读数：班组进场与安全巡检两处都从巡检记录里取，保证对得上。
export function closedHazardCount(): number {
  return listRows('safety').filter((row) => String(row.status) === '已闭环').length
}

// 班组进场待办清单：直接镜像已闭环巡检记录，沿用既有 listRows 读取方式。
export function crewClosureTodos(): EntryRow[] {
  return listRows('crew-todos')
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
