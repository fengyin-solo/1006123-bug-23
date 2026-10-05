<template>
  <section class="page" data-module="safety">
    <header class="page-head">
      <div>
        <h2>安全巡检管理</h2>
        <p class="page-desc">维护巡检记录，围绕巡检编号、巡检区域、巡检项目、发现问题做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记巡检记录</button>
        <button class="btn" type="button" @click="exportRows">导出安全巡检清单</button>
      </div>
    </header>

    <div class="identity-bar">
      <label class="filter-item">
        <span>当前值班人 / 角色</span>
        <select v-model="actorName">
          <option v-for="item in operatorOptions" :key="item.name" :value="item.name">
            {{ item.name }}（{{ item.role }}）
          </option>
        </select>
      </label>
      <label class="filter-item">
        <span>管辖区域</span>
        <select v-model="actorRegion">
          <option v-for="region in regionOptions" :key="region" :value="region">{{ region }}</option>
        </select>
      </label>
      <span class="identity-hint">
        以「{{ actorName }} · {{ actorRole }} · {{ actorRegion }}」身份操作；只有本区域巡检负责人能派发整改
      </span>
    </div>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">
            <template v-if="column === '整改期限' && row.status === '待整改'">
              <span class="danger-badge">{{ row[column] || '—' }}</span>
            </template>
            <template v-else>{{ row[column] || '—' }}</template>
          </td>
          <td>
            <span :class="['status-tag', row.status === '待整改' ? 'tag-danger' : '']">{{ row.status }}</span>
          </td>
          <td class="row-actions">
            <button
              v-for="action in visibleActions(row)"
              :key="action"
              class="link"
              type="button"
              :disabled="actingId === Number(row.id)"
              @click="runAction(action, row)"
            >
              {{ actingId === Number(row.id) && action === actingAction ? '处理中…' : action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无安全巡检数据，可先登记巡检记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条安全巡检记录</span>
      <span v-if="errorMessage" class="error-text">
        {{ errorMessage }}
        <button class="link" type="button" @click="reload">重试取数</button>
      </span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  closureTodos,
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
  safetyStatusCounts,
} from '@/api/local-service'
import { useSessionStore } from '@/stores/session'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('safety')
const session = useSessionStore()
// 巡检状态、隐患等级都收敛到服务层一份，列表不再单独展示「巡检状态」列。
const columns = ["巡检编号", "巡检区域", "巡检项目", "发现问题", "隐患等级", "巡检日期", "整改期限", "闭环时间", "巡检人员"]
const actions = ["提交巡检", "派发整改", "确认闭环"]
const statuses = ["待巡检", "已巡检", "待整改", "已闭环"]

const operatorOptions = [
  { name: '张工', role: '巡检负责人', region: '盾构A区' },
  { name: '李工', role: '巡检负责人', region: '盾构B区' },
  { name: '王工', role: '值班安全员', region: '盾构A区' },
]
const regionOptions = ['盾构A区', '盾构B区']

const actorName = ref(session.operator)
const actorRegion = ref(session.region)

const actorRole = computed(
  () => operatorOptions.find((item) => item.name === actorName.value)?.role ?? '值班安全员',
)

function syncIdentity() {
  session.setIdentity(actorName.value, actorRole.value, actorRegion.value)
}

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const actingId = ref<number | null>(null)
const actingAction = ref('')

// 两张表的统计与状态图例一律从服务层现读，已闭环条数不缓存上一轮结果。
const statusCounts = ref<Record<string, number>>(safetyStatusCounts())
const closedCount = computed(() => closureTodos().length)
const stats = computed(() => [
  { label: '待巡检区域', value: statusCounts.value['待巡检'] ?? 0 },
  { label: '待整改隐患', value: statusCounts.value['待整改'] ?? 0 },
  { label: '已闭环隐患', value: closedCount.value },
])
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: statusCounts.value[status] ?? 0,
  })),
)

// 已闭环的不再给「派发整改」入口；状态机也会在服务层兜底驳回。
function visibleActions(row: EntryRow): string[] {
  return actions.filter((action) => !(action === '派发整改' && String(row.status) === '已闭环'))
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '巡检记录登记入口尚未接入审批流'
}

async function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  // 同一条记录的同一动作进行中：重复点击只当没发生，只认头一笔。
  if (actingId.value !== null) {
    return
  }
  actingId.value = Number(row.id)
  actingAction.value = action
  // 让「处理中…」先画出来，避免双击抢在同一帧内进来。
  await new Promise((resolve) => setTimeout(resolve, 0))
  try {
    syncIdentity()
    const result = applyAction(meta.key, Number(row.id), action, {
      name: session.operator,
      role: session.role,
      region: session.region,
    })
    if (!result.ok) {
      errorMessage.value = result.message
      return
    }
    // 头一次提交后回列表重新确认，取数失败允许重试，不顶用上一轮结果。
    reload()
  } finally {
    actingId.value = null
    actingAction.value = ''
  }
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    statusCounts.value = safetyStatusCounts()
  } catch (error) {
    // 取数失败：清空本轮展示，不拿上一轮结果顶着，等用户点重试。
    rows.value = []
    total.value = 0
    errorMessage.value = error instanceof Error ? error.message : '安全巡检列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.identity-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 12px;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 12px;
}
.identity-hint {
  font-size: 12px;
  color: var(--muted);
}
.status-tag {
  display: inline-block;
  border-radius: 999px;
  padding: 1px 10px;
  background: #eef2f7;
  font-size: 12px;
}
.tag-danger {
  background: #fee4e2;
  color: #b42318;
  font-weight: 600;
}
.danger-badge {
  color: #b42318;
  font-weight: 600;
}
.link:disabled {
  color: #94a3b8;
  cursor: not-allowed;
}
</style>
