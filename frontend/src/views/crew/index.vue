<template>
  <section class="page" data-module="crew">
    <header class="page-head">
      <div>
        <h2>班组进场管理</h2>
        <p class="page-desc">维护施工班组，围绕班组编号、班组名称、主要工种、班组长做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记施工班组</button>
        <button class="btn" type="button" @click="exportRows">导出班组进场清单</button>
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

    <section class="todo-panel">
      <h3>隐患闭环待办清单（进场班组）</h3>
      <p class="page-desc">
        巡检确认闭环后结论落到这里；已闭环隐患 <span class="todo-count">{{ closureTodos.length }}</span> 条，
        与安全巡检模块读数一致。
      </p>
      <table class="data-table">
        <thead>
          <tr>
            <th v-for="column in todoColumns" :key="column">{{ column }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="todo in closureTodos" :key="todo.id">
            <td v-for="column in todoColumns" :key="column">{{ todo[column] || '—' }}</td>
          </tr>
          <tr v-if="!closureTodos.length">
            <td :colspan="todoColumns.length" class="empty-state">暂无已闭环隐患待办</td>
          </tr>
        </tbody>
      </table>
    </section>

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
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无班组进场数据，可先登记施工班组</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条班组进场记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  crewClosureTodos,
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
  statusSummary as summarize,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('crew')
const columns = ["班组编号", "班组名称", "主要工种", "班组长", "进场人数", "安全交底日期", "联系电话", "在场状态"]
const todoColumns = ["来源编号", "巡检区域", "隐患等级", "整改班组", "闭环时间", "待办内容"]
const actions = ["办理进场", "办理退场", "登记停工"]
const statuses = ["待进场", "在场", "已退场", "已停工"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
// 闭环待办沿用既有读取方式从数据层取，安全巡检那边的已闭环数即本清单条数。
const closureTodos = ref<EntryRow[]>([])
const statusSummary = computed(() => summarize(meta.key, statuses))
const stats = computed(() => {
  const byStatus = new Map(statusSummary.value.map((item) => [item.status, item.count]))
  return [
    { label: "在场班组", value: byStatus.get('在场') ?? 0 },
    { label: "闭环待办", value: closureTodos.value.length },
    { label: "停工班组", value: byStatus.get('已停工') ?? 0 },
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
  errorMessage.value = '施工班组登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    closureTodos.value = crewClosureTodos()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '班组进场列表读取失败'
  }
}

onMounted(reload)
</script>
