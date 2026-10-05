/* 端到端核验：用 localStorage 垫片跑数据层+服务层，覆盖闭环收口的全部规则。
   运行：node scripts/verify.mjs（由 verify-build.sh 用 esbuild 打包后执行）。 */

const storeMap = new Map()
globalThis.window = {
  localStorage: {
    getItem: (k) => (storeMap.has(k) ? storeMap.get(k) : null),
    setItem: (k, v) => {
      if (storeMap.get('__fail__')) {
        throw new Error('mock quota exceeded')
      }
      storeMap.set(k, String(v))
    },
    removeItem: (k) => storeMap.delete(k),
  },
}

const api = await import('./dist-verify/bundle.mjs')
const {
  runAction,
  listEntries,
  setActor,
  resetModule,
  closedHazardCount,
  crewClosureTodos,
  statusSummary,
  moduleMeta,
  loadOverview,
  listRows,
} = api

let pass = 0
let fail = 0
function check(name, cond, extra = '') {
  if (cond) {
    pass += 1
    console.log(`  ✓ ${name}`)
  } else {
    fail += 1
    console.error(`  ✗ ${name} ${extra}`)
  }
}

function safetyRow(code) {
  return listRows('safety').find((r) => r['巡检编号'] === code)
}

// ---- 场景 0：存量 v1 数据（旧字段）按巡检日期折算成新版 ----
const legacy = [
  {
    id: 91,
    status: '已闭环',
    pending: true, // 旧版残留：闭环了还挂待办
    abnormal: true,
    巡检编号: 'SAFE-OLD-1',
    巡检区域: '东区',
    巡检项目: '旧版隐患1',
    发现问题: '问题',
    隐患等级: '严重',
    整改期限: '2026-08-10', // 旧版日期
    巡检人员: '张三',
    巡检状态: '安全巡检样例',
  },
  {
    id: 92,
    status: '待整改',
    pending: false, // 旧版残留：待整改反而不挂待办
    abnormal: false,
    巡检编号: 'SAFE-OLD-2',
    巡检区域: '西区',
    巡检项目: '旧版隐患2',
    发现问题: '问题',
    隐患等级: '重大',
    整改期限: '2026-08-20',
    巡检人员: '李四',
    巡检状态: '安全巡检样例',
  },
  {
    id: 93,
    status: '已巡检',
    pending: true,
    abnormal: true,
    巡检编号: 'SAFE-OLD-3',
    巡检区域: '东区',
    巡检项目: '旧版隐患3',
    隐患等级: '一般',
    整改期限: '',
    巡检人员: '王五',
    巡检状态: '已巡检',
  },
]
// 故意塞入一条游离的旧待办，验证迁移以巡检记录重建
const strayTodo = [
  { id: 1, status: '待办', pending: false, abnormal: false, 来源编号: 'GHOST', 待办内容: '幽灵待办' },
]
storeMap.set('shield-tunnel-construction:entries', JSON.stringify({ safety: legacy, 'crew-todos': strayTodo }))
storeMap.set('shield-tunnel-construction:schema-version', '1')

const migrated1 = safetyRow('SAFE-OLD-1')
check('迁移：已闭环记录巡检日期按整改期限折算', migrated1['巡检日期'] === '2026-08-10')
check('迁移：闭环后整改期限清空', migrated1['整改期限'] === '', `实际=${migrated1['整改期限']}`)
check('迁移：闭环记录 pending=false（红色标记消除）', migrated1.pending === false)
check('迁移：闭环记录 abnormal=false', migrated1.abnormal === false)
check('迁移：闭环时间缺失时落头一笔（取巡检日期）', migrated1['闭环时间'] === '2026-08-10')
const migrated2 = safetyRow('SAFE-OLD-2')
check('迁移：待整改 pending/abnormal 跟状态对齐', migrated2.pending === true && migrated2.abnormal === true)
check('迁移：隐患等级归一（严重→较大隐患）', migrated1['隐患等级'] === '较大隐患')
check('迁移：隐患等级归一（重大→重大隐患）', migrated2['隐患等级'] === '重大隐患')
const todosAfterMigrate = crewClosureTodos()
check('迁移：班组待办按已闭环重建，游离待办清除', todosAfterMigrate.every((t) => t['来源编号'] !== 'GHOST'))
check(
  '迁移：已闭环条数两边一致',
  closedHazardCount() === todosAfterMigrate.length && closedHazardCount() === 1,
)

// ---- 场景 1：派发整改权限收口 ----
const eastInspected = safetyRow('SAFE-OLD-3') // 东区、已巡检
setActor({ name: '平台管理员', role: '平台管理员', region: '' })
let r = runAction('safety', eastInspected.id, '派发整改')
check('越权：非巡检负责人派发被拒', r.ok === false && r.message.includes('巡检负责人'))
setActor({ name: '西区负责人', role: '巡检负责人', region: '西区' })
r = runAction('safety', eastInspected.id, '派发整改')
check('跨区域：西区负责人派发东区隐患被拒', r.ok === false && r.message.includes('非本区域'))
setActor({ name: '东区负责人', role: '巡检负责人', region: '东区' })
r = runAction('safety', eastInspected.id, '派发整改')
check('本区域负责人派发成功', r.ok === true && safetyRow('SAFE-OLD-3').status === '待整改')
check('派发后：隐患等级沿用巡检记录', safetyRow('SAFE-OLD-3')['隐患等级'] === '一般隐患')
const dispatchedRow = safetyRow('SAFE-OLD-3')
r = runAction('safety', dispatchedRow.id, '派发整改')
check('重复派发：已是待整改不再受理', r.ok === false)

// ---- 场景 2：已闭环的不许再派发整改 ----
r = runAction('safety', migrated1.id, '派发整改')
check('已闭环隐患再派发被拒', r.ok === false && r.message.includes('已闭环'))

// ---- 场景 3：闭环原子动作（状态+等级+期限+时间+待办一笔） ----
const beforeCloseTime = safetyRow('SAFE-OLD-3')['闭环时间']
r = runAction('safety', dispatchedRow.id, '确认闭环')
const closedRow = safetyRow('SAFE-OLD-3')
check('闭环：状态变已闭环', r.ok && closedRow.status === '已闭环')
check('闭环：pending/abnormal 清零（红色标记消除）', closedRow.pending === false && closedRow.abnormal === false)
check('闭环：整改期限不残留上一版日期', closedRow['整改期限'] === '', `实际=${closedRow['整改期限']}`)
check('闭环：闭环时间已落', String(closedRow['闭环时间']).length === 10)
check('闭环：巡检状态同步为已闭环', closedRow['巡检状态'] === '已闭环')
const todos = crewClosureTodos()
const todo = todos.find((t) => t['来源编号'] === 'SAFE-OLD-3')
check('闭环：结论写入班组进场待办清单', !!todo && todo['待办内容'].includes('已闭环'))
check('闭环：班组待办隐患等级沿用巡检记录', !!todo && todo['隐患等级'] === '一般隐患')
check(
  '闭环：两处已闭环隐患数对得上',
  closedHazardCount() === crewClosureTodos().length,
  `巡检=${closedHazardCount()} 班组=${crewClosureTodos().length}`,
)

// ---- 场景 4：重复点闭环只认头一笔时间，不多记录 ----
const firstCloseTime = closedRow['闭环时间']
const todoCountBefore = crewClosureTodos().length
r = runAction('safety', closedRow.id, '确认闭环')
const closedRow2 = safetyRow('SAFE-OLD-3')
check('重复闭环：第二次被拒且提示头一笔时间', !r.ok && r.message.includes(firstCloseTime))
check('重复闭环：闭环时间不变', closedRow2['闭环时间'] === firstCloseTime)
check('重复闭环：班组待办不多出一条', crewClosureTodos().length === todoCountBefore)

// ---- 场景 5：跳级驳回并说明当前停在哪（切回新版种子数据） ----
storeMap.clear()
// 模块缓存仍保留首次加载的数据，需强制走重置恢复种子
resetModule('safety')
resetModule('crew-todos')
const freshInspected = safetyRow('SAFE-0002') // 种子：已巡检
r = runAction('safety', freshInspected.id, '确认闭环')
check('跳级：已巡检直接闭环被驳回并说明停在「已巡检」', !r.ok && r.message.includes('已巡检'))
const waiting = safetyRow('SAFE-0001') // 待巡检
r = runAction('safety', waiting.id, '派发整改')
check('跳级：待巡检直接派发整改被驳回', !r.ok && r.message.includes('待巡检'))

// ---- 场景 6：写库失败整笔回滚（不许只清一半） ----
setActor({ name: '东区负责人', role: '巡检负责人', region: '东区' })
runAction('safety', freshInspected.id, '派发整改') // 先合规走到待整改
const target = safetyRow('SAFE-0002')
const snapshot = JSON.stringify({ safety: listRows('safety'), 'crew-todos': listRows('crew-todos') })
storeMap.set('__fail__', '1')
r = runAction('safety', target.id, '确认闭环')
storeMap.delete('__fail__')
check('落库失败：动作报错', !r.ok)
const after = JSON.stringify({ safety: listRows('safety'), 'crew-todos': listRows('crew-todos') })
check('落库失败：巡检表与班组待办整笔回滚，无半清状态', after === snapshot)
const rowStill = safetyRow('SAFE-0002')
check('落库失败：记录仍停在待整改', rowStill.status === '待整改' && rowStill['整改期限'] !== '')

// ---- 场景 7：其他业务面记录随统一状态口径对齐 ----
const ring = listRows('ring').find((x) => x.id === 1)
check('其他模块：终态判定沿用同一规则（待掘进→pending）', ring.pending === true)
r = runAction('ring', 1, '确认完成') // 待掘进 → 已贯通，跳级
check('其他模块：跳级一律驳回', !r.ok && r.message.includes('待掘进'))
r = runAction('ring', 1, '开始掘进')
check('其他模块：相邻状态允许流转', r.ok && safetyRow && listRows('ring').find((x) => x.id === 1).status === '掘进中')
const cutter = listRows('cutter').find((x) => x.id === 2)
check('其他模块：待更换按异常口径对齐', cutter.abnormal === true)

// ---- 场景 8：落库结果核对（整改期限不残留、两边计数一致） ----
storeMap.delete('__fail__')
const persisted = JSON.parse(storeMap.get('shield-tunnel-construction:entries'))
check(
  '持久化：所有已闭环记录整改期限均已清空',
  persisted.safety.filter((x) => x.status === '已闭环').every((x) => x['整改期限'] === ''),
)
check('持久化：schema 版本号写入', storeMap.get('shield-tunnel-construction:schema-version') === '2')
check(
  '持久化：班组待办条数与已闭环一致',
  persisted['crew-todos'].length === persisted.safety.filter((x) => x.status === '已闭环').length,
)
// 落库失败那笔没有留下半条待办
check(
  '持久化：失败回滚后待办无 SAFE-0002 残影',
  !persisted['crew-todos'].some((t) => t['来源编号'] === 'SAFE-0002'),
)

// ---- 场景 9：resetModule 后种子数据也自洽 ----
resetModule('safety')
const seedClosed = listRows('safety').filter((x) => x.status === '已闭环')
check('重置：种子已闭环记录 pending=false', seedClosed.every((x) => x.pending === false))
check('重置：种子待整改 abnormal=true', listRows('safety').filter((x) => x.status === '待整改').every((x) => x.abnormal === true))

// ---- 场景 10：概览看板异常量口径 ----
const overview = loadOverview()
const safetyStat = overview.modules.find((m) => m.name === '安全巡检')
check('看板：安全巡检待处理数与状态一致', safetyStat.pending === listRows('safety').filter((x) => x.pending).length)

// ---- 场景 11：模拟刷新重开，v1 存量只迁移一次、待办不重复 ----
const v1Payload = {
  safety: [
    {
      id: 77,
      status: '已闭环',
      pending: true,
      abnormal: true,
      巡检编号: 'SAFE-RELOAD',
      巡检区域: '东区',
      巡检项目: '刷新验证',
      隐患等级: '较大',
      整改期限: '2026-07-01',
      巡检状态: '待整改',
    },
  ],
}
storeMap.clear()
storeMap.set('shield-tunnel-construction:entries', JSON.stringify(v1Payload))
storeMap.set('shield-tunnel-construction:schema-version', '1')
const reloaded = await import('./dist-verify/bundle-reload.mjs')
check('重开：首次加载完成迁移', reloaded.closedHazardCount() === 1)
// 再次"重开"：新模块实例读取已迁移的 storage
const reloaded2 = await import('./dist-verify/bundle-reload2.mjs?t=' + Date.now())
check('重开：已闭环数不翻倍', reloaded2.closedHazardCount() === 1)
check('重开：班组待办不重复', reloaded2.crewClosureTodos().length === 1)
check('重开：等级折算保持', reloaded2.listRows('safety')[0]['隐患等级'] === '较大隐患')
check('重开：版本号停留 v2', storeMap.get('shield-tunnel-construction:schema-version') === '2')

console.log(`\n结果：${pass} 通过，${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
