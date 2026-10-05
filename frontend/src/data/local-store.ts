import { MODULES } from './modules'
import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'shield-tunnel-construction:entries'
const VERSION_KEY = 'shield-tunnel-construction:version'

// 数据版本：存量数据按巡检日期折算成新版，低于该版本就迁移一次。
const DATA_VERSION = 2

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}/

function isDateLike(value: unknown): value is string {
  return typeof value === 'string' && DATE_PATTERN.test(value)
}

/** 把旧版数据折算成新版：状态、待办标记与各模块自有的业务状态字段一次对齐，不留半截。 */
function migrate(raw: Record<string, EntryRow[]>): Record<string, EntryRow[]> {
  const next: Record<string, EntryRow[]> = {}
  for (const meta of MODULES) {
    const rows = raw[meta.key] ?? clone(SEED_ROWS[meta.key] ?? [])
    const terminal = meta.statuses[meta.statuses.length - 1]
    // 各模块最后一个字段就是自己的业务状态（如「巡检状态」），与通用 status 同写同读。
    const bizStatusField = meta.fields[meta.fields.length - 1]
    next[meta.key] = rows.map((row) => {
      const status = String(row.status ?? meta.statuses[0])
      const migrated: EntryRow = {
        ...row,
        status,
        [bizStatusField]: status,
        pending: status !== terminal,
      }
      if (meta.key === 'safety') {
        migrateSafetyRow(migrated, status)
      }
      return migrated
    })
  }
  return next
}

/** 巡检单的存量折算：补齐巡检日期；已闭环的清掉残留整改期限，只保留头一笔闭环时间。 */
function migrateSafetyRow(row: EntryRow, status: string): void {
  if (!isDateLike(row['巡检日期'])) {
    row['巡检日期'] = isDateLike(row['整改期限']) ? row['整改期限'] : '2026-09-01'
  }
  if (status === '已闭环') {
    if (!isDateLike(row['闭环时间'])) {
      row['闭环时间'] = `${String(row['巡检日期']).slice(0, 10)} 09:00`
    }
    if (!String(row['闭环结论'] ?? '').trim()) {
      row['闭环结论'] = `隐患已确认闭环，整改完成（${String(row['巡检编号'] ?? '')}）`
    }
    // 上一版残留的整改期限不再展示，闭环一笔清干净。
    row['整改期限'] = ''
    row.pending = false
  }
}

function storedVersion(): number {
  if (typeof window === 'undefined' || !window.localStorage) {
    return DATA_VERSION
  }
  const value = Number(window.localStorage.getItem(VERSION_KEY))
  return Number.isFinite(value) && value > 0 ? value : 1
}

function readStorage(): Record<string, EntryRow[]> {
  // 种子也折算成新版，存储里缺模块时补进来的不会是旧口径。
  const fallback = migrate(clone(SEED_ROWS))
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    persist(fallback, DATA_VERSION)
    return fallback
  }
  let parsed: Record<string, EntryRow[]>
  try {
    parsed = JSON.parse(raw) as Record<string, EntryRow[]>
  } catch {
    persist(fallback, DATA_VERSION)
    return fallback
  }
  const version = storedVersion()
  if (version < DATA_VERSION) {
    const migrated = migrate({ ...clone(SEED_ROWS), ...parsed })
    persist(migrated, DATA_VERSION)
    return migrated
  }
  return { ...fallback, ...parsed }
}

/** 落库：写不成功就把内存快照一并退回，调用方拿不到半成品数据。 */
function persist(snapshot: Record<string, EntryRow[]>, version: number): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot))
  window.localStorage.setItem(VERSION_KEY, String(version))
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

/** 整份快照一次提交：任意一处写失败，内存与存储都退回上一版。 */
export function commitSnapshot(next: Record<string, EntryRow[]>): void {
  const previous = cache
  cache = next
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch (error) {
    cache = previous
    throw error
  }
}

export function saveRows(key: string, rows: EntryRow[]): void {
  commitSnapshot({ ...allRows(), [key]: rows })
}

export function resetRows(key: string): EntryRow[] {
  const rows = migrate({ [key]: clone(SEED_ROWS[key] ?? []) })[key]
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
