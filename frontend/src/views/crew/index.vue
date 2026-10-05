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
      <article class="stat-card">
        <span class="stat-label">已闭环隐患（来自安全巡检）</span>
        <strong class="stat-value">{{ closedTodos.length }}</strong>
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

    <h3 class="todo-head">班组进场待办 · 隐患闭环结论</h3>
    <p class="page-desc">条目直接折算自安全巡检记录，已闭环条数与巡检列表保持一致。</p>
    <table class="data-table">
      <thead>
        <tr>
          <th>巡检编号</th>
          <th>巡检区域</th>
          <th>隐患等级</th>
          <th>闭环时间</th>
          <th>闭环结论</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="todo in closedTodos" :key="String(todo.id)">
          <td>{{ todo.巡检编号 }}</td>
          <td>{{ todo.巡检区域 }}</td>
          <td>{{ todo.隐患等级 }}</td>
          <td>{{ todo.闭环时间 }}</td>
          <td>{{ todo.闭环结论 }}</td>
        </tr>
        <tr v-if="!closedTodos.length">
          <td colspan="5" class="empty-state">暂无已闭环隐患，闭环结论确认后会进入本待办清单</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条班组进场记录</span>
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
} from '@/api/local-service'
import type { ClosureTodo, EntryRow } from '@/data/types'

const meta = moduleMeta('crew')
const columns = ["班组编号", "班组名称", "主要工种", "班组长", "进场人数", "安全交底日期", "联系电话", "在场状态"]
const actions = ["办理进场", "办理退场", "登记停工"]
const statuses = ["待进场", "在场", "已退场", "已停工"]
const stats = [{"label": "在场班组", "value": 0}, {"label": "在场人数", "value": 0}, {"label": "停工班组", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
// 闭环待办沿用巡检记录的既有读取方式，不另写一套。
const closedTodos = ref<ClosureTodo[]>([])
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

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
    closedTodos.value = closureTodos()
  } catch (error) {
    rows.value = []
    total.value = 0
    errorMessage.value = error instanceof Error ? error.message : '班组进场列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.todo-head {
  margin: 20px 0 4px;
  font-size: 15px;
}
</style>
