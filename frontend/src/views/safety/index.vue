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
        <tr v-for="row in rows" :key="String(row.id)" :class="{ 'row-abnormal': row.abnormal }">
          <td v-for="column in columns" :key="column">{{ row[column] || '—' }}</td>
          <td>
            {{ row.status }}
            <span v-if="row.abnormal" class="tag-pending">待整改</span>
          </td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              :disabled="submittingId === row.id"
              @click="runAction(action, row)"
            >
              {{ action }}
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
        <button class="btn ghost retry-btn" type="button" @click="reload">重试取数</button>
      </span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  closedHazardCount,
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
  statusSummary as summarize,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('safety')
const columns = meta.fields
const actions = ["提交巡检", "派发整改", "确认闭环"]
const statuses = meta.statuses

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const submittingId = ref<number | null>(null)

// 统计直接读数据层：已闭环条数与班组进场看到的是同一个数。
const statusSummary = computed(() => summarize(meta.key, statuses))
const stats = computed(() => {
  const byStatus = new Map(statusSummary.value.map((item) => [item.status, item.count]))
  return [
    { label: '待巡检区域', value: byStatus.get('待巡检') ?? 0 },
    { label: '待整改隐患', value: byStatus.get('待整改') ?? 0 },
    { label: '已闭环隐患', value: closedHazardCount() },
  ]
})

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

function runAction(action: string, row: EntryRow) {
  if (submittingId.value !== null) {
    return
  }
  errorMessage.value = ''
  submittingId.value = Number(row.id)
  try {
    const result = applyAction(meta.key, Number(row.id), action)
    if (!result.ok) {
      errorMessage.value = result.message
      return
    }
    // 头一次提交生效后立刻回列表重新取数确认。
    reload()
  } finally {
    submittingId.value = null
  }
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    // 取数失败不顶用上一轮结果：清空列表，允许重试。
    rows.value = []
    total.value = 0
    errorMessage.value = error instanceof Error ? error.message : '安全巡检列表读取失败'
  }
}

onMounted(reload)
</script>
