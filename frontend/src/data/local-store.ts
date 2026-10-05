import { SEED_ROWS } from './seed'
import { MODULE_BY_KEY } from './modules'
import { isAbnormalStatus, isPendingStatus, normalizeHazardLevel } from './rules'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'shield-tunnel-construction:entries'
// 数据结构版本：升级后首次加载时把存量数据折算成新版。
const VERSION_KEY = 'shield-tunnel-construction:schema-version'
const CURRENT_VERSION = 2

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function normalizeSeed(): Record<string, EntryRow[]> {
  const seeded = clone(SEED_ROWS)
  // 种子数据本身也按统一口径派生 pending / abnormal，避免示例数据自相矛盾。
  for (const [key, rows] of Object.entries(seeded)) {
    const meta = MODULE_BY_KEY.get(key)
    if (!meta) {
      continue
    }
    seeded[key] = rows.map((row) => ({
      ...row,
      pending: isPendingStatus(meta, String(row.status)),
      abnormal: isAbnormalStatus(String(row.status)),
    }))
  }
  return seeded
}

// 存量巡检折算成新版：按巡检日期补齐字段，pending/abnormal 跟随当前状态，
// 整改期限在闭环后清空；班组待办按已闭环记录统一重建，保证两边条数一致。
const SAFETY_META = MODULE_BY_KEY.get('safety')!

function migrateSafety(rows: EntryRow[]): EntryRow[] {
  return rows.map((row) => {
    const next: EntryRow = { ...row }
    // 巡检状态字段与主状态同源：不管存量里写了什么，一律对齐到当前 status。
    next['巡检状态'] = String(next.status)
    // 巡检日期：新版必填；存量没有就按巡检日期折算——用整改期限顶上，再不行留空。
    if (next['巡检日期'] === undefined || next['巡检日期'] === '') {
      next['巡检日期'] = String(next['整改期限'] ?? '')
    }
    if (next['责任区域'] === undefined || next['责任区域'] === '') {
      next['责任区域'] = String(next['巡检区域'] ?? '')
    }
    next['隐患等级'] = normalizeHazardLevel(next['隐患等级'])
    const closed = String(next.status) === '已闭环'
    if (closed) {
      // 闭环后整改期限不得残留上一版日期；闭环时间缺失的按巡检日期落头一笔。
      next['整改期限'] = ''
      if (next['闭环时间'] === undefined || next['闭环时间'] === '') {
        next['闭环时间'] = String(next['巡检日期'] ?? '')
      }
      if (next['闭环结论'] === undefined) {
        next['闭环结论'] = '隐患已闭环'
      }
    } else {
      if (next['闭环时间'] === undefined) {
        next['闭环时间'] = ''
      }
      if (next['闭环结论'] === undefined) {
        next['闭环结论'] = ''
      }
    }
    next['pending'] = isPendingStatus(SAFETY_META, String(next.status))
    next['abnormal'] = isAbnormalStatus(String(next.status))
    return next
  })
}

// 班组待办以安全巡检为唯一来源重建：一条已闭环隐患一条待办，杜绝重复闭环多出一条。
function rebuildCrewTodos(safetyRows: EntryRow[]): EntryRow[] {
  return safetyRows
    .filter((row) => String(row.status) === '已闭环')
    .map((row, index) => ({
      id: index + 1,
      status: '待办',
      pending: false,
      abnormal: false,
      来源编号: String(row['巡检编号'] ?? row.id),
      巡检区域: String(row['巡检区域'] ?? ''),
      隐患等级: normalizeHazardLevel(row['隐患等级']),
      整改班组: String(row['整改班组'] ?? '责任班组'),
      闭环时间: String(row['闭环时间'] ?? ''),
      待办内容: `已闭环：${String(row['闭环结论'] ?? '隐患已闭环')}`,
    }))
}

// 把读到的存量数据整体折算到当前版本，其他业务面的记录也按统一状态口径对齐。
function migrateToCurrent(data: Record<string, EntryRow[]>): Record<string, EntryRow[]> {
  const next: Record<string, EntryRow[]> = {}
  for (const [key, rows] of Object.entries(data)) {
    if (key === 'safety') {
      next[key] = migrateSafety(rows)
      continue
    }
    if (key === 'crew-todos') {
      // 待办清单由巡检记录重建，不沿用旧副本，避免两边各写一套。
      continue
    }
    const meta = MODULE_BY_KEY.get(key)
    next[key] = meta
      ? rows.map((row) => ({
          ...row,
          pending: isPendingStatus(meta, String(row.status)),
          abnormal: isAbnormalStatus(String(row.status)),
        }))
      : clone(rows)
  }
  // 补齐存量里可能缺表的模块（如新版才有的班组待办）。
  const seeded = normalizeSeed()
  for (const [key, rows] of Object.entries(seeded)) {
    if (next[key] === undefined) {
      next[key] = rows
    }
  }
  next['crew-todos'] = rebuildCrewTodos(next['safety'] ?? [])
  return next
}

function readSchemaVersion(): number {
  if (typeof window === 'undefined' || !window.localStorage) {
    return CURRENT_VERSION
  }
  return Number(window.localStorage.getItem(VERSION_KEY) ?? 1)
}

function persist(data: Record<string, EntryRow[]>): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  // setItem 抛错（配额、隐私模式等）时由调用方整笔退回，不许只清一半。
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
  window.localStorage.setItem(VERSION_KEY, String(CURRENT_VERSION))
}

function seedFresh(): Record<string, EntryRow[]> {
  const seeded = normalizeSeed()
  persist(seeded)
  return seeded
}

function readStorage(): Record<string, EntryRow[]> {
  if (typeof window === 'undefined' || !window.localStorage) {
    return normalizeSeed()
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    return seedFresh()
  }
  let parsed: Record<string, EntryRow[]>
  try {
    parsed = JSON.parse(raw) as Record<string, EntryRow[]>
  } catch {
    return seedFresh()
  }
  const version = readSchemaVersion()
  if (version < CURRENT_VERSION) {
    const migrated = migrateToCurrent(parsed)
    // 迁移结果先落库，落不进去就继续用内存折算值，绝不留半截。
    try {
      persist(migrated)
    } catch {
      /* 内存里的 migrated 已是整份新版，本次先用着，下次再重试落库 */
    }
    return migrated
  }
  // 已是当前版本：以种子补齐缺失模块（如新版才有的 crew-todos 表）。
  return { ...normalizeSeed(), ...parsed }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

// 多表原子提交：先在内存里拼好整份快照，落 localStorage 成功后才切换缓存；
// 任一张表写失败都整笔退回，调用方拿到的仍是提交前的数据。
export function commitTables(changes: Record<string, EntryRow[]>): void {
  const base = allRows()
  const next = { ...base, ...changes }
  const previous = cache
  cache = next
  try {
    persist(next)
  } catch (error) {
    cache = previous
    throw error instanceof Error ? error : new Error('数据落库失败')
  }
}

// 单表写也走原子提交，业务层不再各写一套。
export function saveRows(key: string, rows: EntryRow[]): void {
  commitTables({ [key]: rows })
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  const meta = MODULE_BY_KEY.get(key)
  const normalized = meta
    ? rows.map((row) => ({
        ...row,
        pending: isPendingStatus(meta, String(row.status)),
        abnormal: isAbnormalStatus(String(row.status)),
      }))
    : rows
  saveRows(key, normalized)
  return normalized
}

export function storageKey(): string {
  return STORAGE_KEY
}
