/**
 * dsh-better-interface — Host-half harness test (Phase 2.1 + 3 + 4.1 + 5).
 *
 *   node host-test.mjs
 *
 * Drives index.js apply() with a stub ctx that PROVIDES sessions +
 * sessionPersistence + sessionTitle + webServer. Asserts:
 *   - the user-message index (source.kind === 'user' only, oldest first, text
 *     truncated) — unchanged by Phase 4.1/5;
 *   - Phase 4.1 Live/Cold branch enumeration (persistence + live merge, live
 *     precedence, multi-level, no resume);
 *   - Phase 5 branch name rules (session/title data.title, title first,
 *     fallback to first new user message);
 *   - Phase 5 rename endpoint (live success, blank title rejected, unknown
 *     session 404, cold session explicit error, sessionTitle missing degrade,
 *     loopback guard, method guard);
 *   - degradation, ?debug=1 and the error branches.
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { apply } from './index.js'
import { domainSpec } from './lib/host/manage-handler.js'

let passed = 0
function ok(name, detail) {
  passed += 1
  console.log('  ✓ ' + name + (detail !== undefined ? ' — ' + detail : ''))
}

// ── fixture: 两回合会话 + 一条 synthetic 注入（必须被过滤）──────────────
const fixtureEvents = [
  { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
  { type: 'user/message', seq: 1, time: 2, data: { content: [{ type: 'text', text: '第一条消息' }], source: { kind: 'user' } }, surfaceOp: 'append' },
  { type: 'assistant/message', seq: 2, time: 3, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '第一条回复' }], source: { kind: 'model' } } }, surfaceOp: 'append' },
  { type: 'user/message', seq: 3, time: 4, data: { content: [{ type: 'text', text: 'The user manually ran Cordis Plugin x, but it failed: boom' }], source: { kind: 'plugin', plugin: 'cordis-host-runner' } }, surfaceOp: 'append' },
  { type: 'turn/end', seq: 4, time: 5, data: { turn: 1 } },
  { type: 'turn/start', seq: 5, time: 6, data: { turn: 2 } },
  { type: 'user/message', seq: 6, time: 7, data: { content: [{ type: 'text', text: '这是一条超过三十个字符的很长很长的用户消息，需要被截断显示前三十个字符' }], source: { kind: 'user' } }, surfaceOp: 'append' },
]

function userMessage(seq, text) {
  return { type: 'user/message', seq, time: 1, data: { content: [{ type: 'text', text }], source: { kind: 'user' } } }
}
function endSeed(seq) {
  return { type: 'session/end-seed', seq, time: 1, data: {} }
}
function titleEvent(seq, title) {
  return { type: 'session/title', seq, time: 1, data: { title, messageSeqs: [], source: { kind: 'user' } } }
}

// ── Branch fixtures ────────────────────────────────────────────────────
// branch-a：Live，无 session/title → branchText 回退首条新用户消息。
const eventsA = [userMessage(0, 'seed 继承'), userMessage(1, 'seed 继承'), userMessage(2, '使用 seed 创建分支')]
const branchA = { id: 'branch-a', header: { id: 'branch-a', parentSession: 'session-test', seedLength: 2 }, firstLiveSeq: 2, events: eventsA }

// branch-title：Live，有 session/title（data.title）→ branchText 优先真实名称。
const eventsTitle = [
  userMessage(0, 'seed 继承'),
  userMessage(1, 'seed 继承'),
  titleEvent(2, '重构 FPGA DMA 架构'),
  userMessage(3, '首条新用户消息（有 title 时不应显示）'),
]
const branchTitle = { id: 'branch-title', header: { id: 'branch-title', parentSession: 'session-test', seedLength: 2 }, firstLiveSeq: 2, events: eventsTitle }

// branch-d：同一 id 同时出现在 persistence.list（cold 视图）与 sessions.list
// （live 视图）→ 合并去重且 live 优先（文本必须是 live 版本）。
const branchD = {
  id: 'branch-d',
  header: { id: 'branch-d', parentSession: 'session-test', seedLength: 2 },
  firstLiveSeq: 2,
  events: [userMessage(0, 'seed 继承'), userMessage(1, 'seed 继承'), userMessage(2, 'live 优先文本')],
}

// branch-cold：纯 Cold（只出现在 persistence.list；sessions.list 不含）。
// seedLength=7 → 边界 seq6；log 以 session/end-seed(7) 结尾后接新消息(8)。
const eventsCold = [
  ...Array.from({ length: 7 }, (_, s) => userMessage(s, 'seed 继承')),
  endSeed(7),
  userMessage(8, '换一种架构实现'),
]
const branchCold = { id: 'branch-cold', header: { id: 'branch-cold', parentSession: 'session-test', seedLength: 7 } }

// branch-a1：Cold，二级（parentSession=branch-a）。seedLength=3 → 边界 seq2。
const eventsA1 = [
  ...Array.from({ length: 3 }, (_, s) => userMessage(s, '继承 a')),
  endSeed(3),
  userMessage(4, 'a1 自己的消息'),
]
const branchA1 = { id: 'branch-a1', header: { id: 'branch-a1', parentSession: 'branch-a', seedLength: 3 } }

// branch-a1-1：Cold，三级（parentSession=branch-a1）。seedLength=5 → 边界 seq4。
const eventsA1_1 = [
  ...Array.from({ length: 5 }, (_, s) => userMessage(s, '继承 a1')),
  endSeed(5),
  userMessage(6, 'a1-1 自己的消息'),
]
const branchA1_1 = { id: 'branch-a1-1', header: { id: 'branch-a1-1', parentSession: 'branch-a1', seedLength: 5 } }

// ── stubs：sessions + sessionPersistence + sessionTitle + webServer 均 PROVIDED ──
const inspectCalls = []
const renameCalls = []
let nextTitleSeq = 100
const routes = []
const ctxStub = {
  sessions: {
    get: (id) => {
      if (id === 'session-test') return { id, events: fixtureEvents, firstLiveSeq: 0 }
      if (id === 'branch-a') return { id, events: eventsA, firstLiveSeq: 2 }
      if (id === 'branch-a1') return { id, events: eventsA1, firstLiveSeq: 4 }
      return undefined
    },
    list: () => [branchA, branchTitle, branchD, { id: 'session-test', header: { id: 'session-test', parentSession: undefined }, events: fixtureEvents, firstLiveSeq: 0 }],
  },
  sessionPersistence: {
    // 模拟 JSONL backend 的 locate：纯路径计算，返回每会话文件绝对路径。
    locate: (meta) => ({ kind: 'jsonl', path: 'C:\\Users\\t\\.dsh\\sessions\\--proj--\\session-' + meta.id + '\\session.jsonl.zstd' }),
    list: async () => [branchA.header, branchD.header, branchCold.header, branchA1.header, branchA1_1.header, branchTitle.header],
    inspect: async (id) => {
      inspectCalls.push(id)
      if (id === 'branch-cold') return { meta: branchCold.header, events: eventsCold }
      if (id === 'branch-a1') return { meta: branchA1.header, events: eventsA1 }
      if (id === 'branch-a1-1') return { meta: branchA1_1.header, events: eventsA1_1 }
      if (id === 'branch-d') return { meta: branchD.header, events: [userMessage(0, 'seed 继承'), userMessage(1, 'seed 继承'), userMessage(2, 'cold 版本文本')] }
      if (id === 'branch-title') return { meta: branchTitle.header, events: eventsTitle }
      return undefined
    },
  },
  sessionTitle: {
    // 模拟 DSH SessionTitleService.rename：append session/title 事件（pins 标题）。
    rename: (session, title) => {
      renameCalls.push({ id: session.id, title })
      const seq = nextTitleSeq++
      session.events.push({ type: 'session/title', seq, time: Date.now(), data: { title, messageSeqs: [], source: { kind: 'user' } } })
      return { title, messageSeqs: [], source: { kind: 'user' }, eventSeq: seq, updatedAt: Date.now() }
    },
  },
  webServer: {
    register: (route) => { routes.push(route); return () => {} },
  },
  effect: () => () => {},
  logger: { info: () => {}, warn: () => {} },
  // Phase 6：storageDomain（fake KV 域：Map 封装）
  storageDomain: {
    open: async (spec) => ({
      name: spec.name,
      close: () => {},
      table: () => ({
        get: (k) => stateStore.get(k),
        put: async (k, v) => { stateStore.set(k, v) },
        delete: async (k) => stateStore.delete(k),
        entries: () => stateStore.entries(),
        keys: () => stateStore.keys(),
        size: 0,
      }),
    }),
  },
  // Phase 6：workspaceRegistry（原生归档集合；getter 延迟读取 nativeArchivedIds）
  workspaceRegistry: {
    get archivedSessionIds() { return nativeArchivedIds },
  },
}
const stateStore = new Map()
let nativeArchivedIds = []

// ── drive apply ───────────────────────────────────────────────────────
await apply(ctxStub, { previewChars: 30 })
const sessionRoute = routes.find((r) => r.path === '/better-interface/session')
const renameRoute = routes.find((r) => r.path === '/better-interface/rename')
const locationRoute = routes.find((r) => r.path === '/better-interface/session-location')
const manageRoute = routes.find((r) => r.path === '/better-interface/manage-sessions')
const stateRoute = routes.find((r) => r.path === '/better-interface/session-state')
assert.ok(sessionRoute, '必须注册 GET /better-interface/session')
assert.ok(renameRoute, '必须注册 POST /better-interface/rename')
assert.ok(locationRoute, '必须注册 GET /better-interface/session-location')
assert.ok(manageRoute, '必须注册 GET /better-interface/manage-sessions')
assert.ok(stateRoute, '必须注册 POST /better-interface/session-state')
assert.equal(routes.length, 5, '注册 5 条路由（session + rename + location + manage + state）')
ok('路由注册', 'session/rename/location/manage-sessions/session-state（inject 含 webServer+sessions+sessionPersistence+sessionTitle+storageDomain）')

async function callHandler(handler, url, opts = {}) {
  const req = new EventEmitter()
  req.method = opts.method || 'GET'
  req.headers = { host: opts.host || 'localhost:3080' }
  req.url = url
  let status, payload
  const res = {
    writeHead: (s) => { status = s },
    end: (t) => { payload = JSON.parse(t) },
  }
  const p = handler(req, res)
  if (opts.body !== undefined) req.emit('data', Buffer.from(JSON.stringify(opts.body)))
  req.emit('end')
  await p
  return { status, payload }
}

// ── 200：只含真实用户输入 + 一级 Branch（Live + Cold + title 优先）───────
const ok200 = await callHandler(sessionRoute.handler, '/better-interface/session?sessionId=session-test')
assert.equal(ok200.status, 200, '应返回 200')
assert.equal(ok200.payload.sessionId, 'session-test')
assert.equal(ok200.payload.branchAvailable, true, 'persistence+live 均可用 → branchAvailable=true')
assert.equal(ok200.payload.messages.length, 2, '应索引出 2 条真实用户消息（synthetic 注入被排除）')
assert.equal(ok200.payload.messages[0].seq, 1)
assert.equal(ok200.payload.messages[0].text, '第一条消息', '短消息不截断')
assert.equal(ok200.payload.messages[1].seq, 6)
assert.equal(ok200.payload.messages[1].text.length, 31, '长消息截断为 30 字符 + …')
assert.ok(ok200.payload.messages[1].text.endsWith('…'))
assert.equal(ok200.payload.messages.some((m) => m.text.includes('Cordis Plugin')), false, 'synthetic 注入文本不得进入索引')
const hasOnlyExpectedKeys = ok200.payload.messages.every((m) => Object.keys(m).sort().join(',') === 'branches,seq,text')
assert.equal(hasOnlyExpectedKeys, true, 'ConversationItem 只含 seq + text + branches')
ok('GET /session 200', '2 条真实用户消息正序，text 截断 30，payload 为 {seq,text,branches}')

// ── 一级 Branch 挂载：Live 发现 + Cold 发现 + 合并不重复 + title 优先 ───
const branchesAt1 = ok200.payload.messages[0].branches
const branchesAt6 = ok200.payload.messages[1].branches
assert.equal(branchesAt1.length, 3, 'seq 1 下应有 3 个 Branch（branch-a / branch-title / branch-d）')
assert.equal(branchesAt6.length, 1, 'seq 6 下应有 1 个 Branch（branch-cold）')
const a = branchesAt1.find((b) => b.sessionId === 'branch-a')
assert.ok(a, 'Live branch-a 应被发现')
assert.equal(a.text, '使用 seed 创建分支', '无 title → fallback 首条新用户消息')
const t = branchesAt1.find((b) => b.sessionId === 'branch-title')
assert.ok(t, 'branch-title 应被发现')
assert.equal(t.text, '重构 FPGA DMA 架构', '有 session/title → title 优先（data.title 正确读取）')
const d = branchesAt1.find((b) => b.sessionId === 'branch-d')
assert.ok(d, 'branch-d 应出现（live+cold 同 id 合并）')
assert.equal(d.text, 'live 优先文本', '同 id 合并时 live 优先')
assert.equal(branchesAt1.filter((b) => b.sessionId === 'branch-d').length, 1, '同 id 不重复出现')
const cold = branchesAt6.find((b) => b.sessionId === 'branch-cold')
assert.ok(cold, 'Cold branch-cold 应被发现')
assert.equal(cold.text, '换一种架构实现', 'Cold Branch 文本由 session/end-seed 推导')
const branchKeysOk = [...branchesAt1, ...branchesAt6].every((br) => Object.keys(br).sort().join(',') === 'parentSessionId,seedLength,sessionId,text')
assert.equal(branchKeysOk, true, 'BranchItem 只含 sessionId/parentSessionId/text/seedLength')
ok('一级 Branch（Live+Cold+合并+title）', 'title 优先显示真实名称；无 title 回退首条新消息')

// ── Cold 只读：inspect 被调用，但绝不 open / resume ───────────────────
assert.ok(inspectCalls.includes('branch-cold'), 'cold child 应经 persistence.inspect 读取')
assert.equal(inspectCalls.includes('branch-a'), false, 'live child 不应 inspect（直接取内存）')
assert.equal(typeof ctxStub.sessions.open, 'undefined', 'stub 无 open：端点路径不可能调用 open')
assert.equal(typeof ctxStub.sessions.resume, 'undefined', 'stub 无 resume：端点路径不可能自动 resume')
ok('Cold 不 resume', '读取走 persistence.inspect（只读），无 open / 无自动 resume')

// ── 二级 / 三级 Branch ────────────────────────────────────────────────
const aView = await callHandler(sessionRoute.handler, '/better-interface/session?sessionId=branch-a')
assert.equal(aView.payload.messages.length, 3)
const aLast = aView.payload.messages[2]
assert.equal(aLast.seq, 2)
assert.equal(aLast.branches.length, 1)
assert.equal(aLast.branches[0].sessionId, 'branch-a1')
assert.equal(aLast.branches[0].text, 'a1 自己的消息', '二级 Cold Branch 文本推导正确')
ok('二级 Branch', 'parentSession=branch-a 的 child 挂到对应消息下')
const a1View = await callHandler(sessionRoute.handler, '/better-interface/session?sessionId=branch-a1')
assert.equal(a1View.payload.messages.length, 4)
const a1Last = a1View.payload.messages[3]
assert.equal(a1Last.seq, 4)
assert.equal(a1Last.branches.length, 1)
assert.equal(a1Last.branches[0].sessionId, 'branch-a1-1')
assert.equal(a1Last.branches[0].text, 'a1-1 自己的消息', '三级 Cold Branch 文本推导正确')
ok('三级 Branch', '任意层级：沿 Branch 树逐级发现子 Branch')

// ── 降级 A：无 sessionPersistence → branchAvailable=false，live 分支仍显示 ──
const routes2 = []
const ctxNoPersistence = {
  sessions: { get: (id) => (id === 'session-test' ? { id, events: fixtureEvents, firstLiveSeq: 0 } : undefined), list: () => [branchA] },
  sessionTitle: ctxStub.sessionTitle,
  webServer: { register: (route) => { routes2.push(route); return () => {} } },
  effect: () => () => {},
  logger: { info: () => {}, warn: () => {} },
}
await apply(ctxNoPersistence, { previewChars: 30 })
const routeNoP = routes2.find((r) => r.path === '/better-interface/session')
const degA = await callHandler(routeNoP.handler, '/better-interface/session?sessionId=session-test')
assert.equal(degA.payload.branchAvailable, false, '无 sessionPersistence → branchAvailable=false')
assert.equal(degA.payload.messages[0].branches.length, 1, 'live 分支仍显示')
ok('降级 A（无 persistence）', '安全降级到 live-only，索引照常')

// ── 降级 B：persistence.list 抛错 → branchAvailable=false，live 分支仍显示 ──
const routes3 = []
const ctxBadList = {
  sessions: { get: (id) => (id === 'session-test' ? { id, events: fixtureEvents, firstLiveSeq: 0 } : undefined), list: () => [branchA] },
  sessionPersistence: { list: async () => { throw new Error('backend down') }, inspect: async () => ({ meta: {}, events: [] }) },
  sessionTitle: ctxStub.sessionTitle,
  webServer: { register: (route) => { routes3.push(route); return () => {} } },
  effect: () => () => {},
  logger: { info: () => {}, warn: () => {} },
}
await apply(ctxBadList, { previewChars: 30 })
const routeBad = routes3.find((r) => r.path === '/better-interface/session')
const degB = await callHandler(routeBad.handler, '/better-interface/session?sessionId=session-test')
assert.equal(degB.payload.branchAvailable, false, 'persistence.list 抛错 → branchAvailable=false')
assert.equal(degB.payload.messages[0].branches.length, 1, 'live 分支仍显示')
ok('降级 B（persistence.list 抛错）', '安全降级，不影响索引与 live 分支')

// ── 降级 C：单个 cold child inspect 抛错 → 跳过该 child，其余正常 ──────
const routes4 = []
const ctxBadInspect = {
  sessions: { get: (id) => (id === 'session-test' ? { id, events: fixtureEvents, firstLiveSeq: 0 } : undefined), list: () => [branchA] },
  sessionPersistence: {
    list: async () => [branchA.header, branchCold.header],
    inspect: async (id) => { if (id === 'branch-cold') throw new Error('corrupt artifact'); return { meta: branchA.header, events: eventsA } },
  },
  sessionTitle: ctxStub.sessionTitle,
  webServer: { register: (route) => { routes4.push(route); return () => {} } },
  effect: () => () => {},
  logger: { info: () => {}, warn: () => {} },
}
await apply(ctxBadInspect, { previewChars: 30 })
const routeBadI = routes4.find((r) => r.path === '/better-interface/session')
const degC = await callHandler(routeBadI.handler, '/better-interface/session?sessionId=session-test')
assert.equal(degC.payload.branchAvailable, true, '枚举成功时 branchAvailable 保持 true')
assert.equal(degC.payload.messages[0].branches.length, 1, '正常 child 仍挂载')
assert.equal(degC.payload.messages[1].branches.length, 0, 'inspect 失败的 cold child 被跳过')
ok('降级 C（单个 inspect 失败）', '跳过失败 child + warn，其余分支不受影响')

// ── debug=1 / 404 / 400 / 403（session 端点）───────────────────────────
const dbg = await callHandler(sessionRoute.handler, '/better-interface/session?sessionId=session-test&debug=1')
assert.equal(dbg.status, 200)
assert.ok(dbg.payload.debug)
assert.deepEqual(dbg.payload.debug.sourceKinds, { user: 2, plugin: 1 })
ok('debug=1 只读调查', '事件/来源分布 + 样本，正常索引不变')
const nf = await callHandler(sessionRoute.handler, '/better-interface/session?sessionId=ghost')
assert.equal(nf.status, 404)
ok('404 分支（session）', '未知 session → SESSION_NOT_FOUND')
const b1 = await callHandler(sessionRoute.handler, '/better-interface/session')
assert.equal(b1.status, 400)
ok('400 分支（session）', '缺 sessionId → BAD_REQUEST')
const f = await callHandler(sessionRoute.handler, '/better-interface/session?sessionId=session-test', { host: 'evil.example.com' })
assert.equal(f.status, 403)
ok('loopback 守卫（session）', '非本地主机 → 403')
const m405 = await callHandler(sessionRoute.handler, '/better-interface/session?sessionId=session-test', { method: 'POST', body: {} })
assert.equal(m405.status, 405, 'POST 到 session 端点应 405')
ok('method 守卫（session）', '非 GET → 405')

// ── 原 Session 零修改（在 rename 测试之前：rename 会合法 append title 事件）─
assert.equal(fixtureEvents[1].data.content[0].text, '第一条消息', '原事件对象必须未被修改')
assert.equal(eventsA.length, 3, 'rename 前 child 事件保持原样')
assert.equal(eventsCold.length, 9, 'cold 事件保持原样')
ok('原 Session 零修改', 'events 保持原样（只读快照；rename 只 append 新 title 事件）')

// ══ Phase 5：POST /better-interface/rename ══
// ── Live rename 成功 ────────────────────────────────────────────────
const rnOk = await callHandler(renameRoute.handler, '/better-interface/rename', { method: 'POST', body: { sessionId: 'branch-a', title: '新名称' } })
assert.equal(rnOk.status, 200, 'live rename 应 200')
assert.equal(rnOk.payload.ok, true)
assert.equal(rnOk.payload.sessionId, 'branch-a')
assert.equal(rnOk.payload.title, '新名称')
assert.equal(typeof rnOk.payload.seq, 'number')
assert.deepEqual(renameCalls, [{ id: 'branch-a', title: '新名称' }], 'sessionTitle.rename 应以 (session, title) 调用')
// 保存后索引反映新名称（title 优先 + stub append 了 session/title 事件）
const afterRename = await callHandler(sessionRoute.handler, '/better-interface/session?sessionId=session-test')
const aAfter = afterRename.payload.messages[0].branches.find((b) => b.sessionId === 'branch-a')
assert.equal(aAfter.text, '新名称', 'rename 后 Branch 显示新名称（重新读取）')
ok('Live Rename 成功', 'POST rename → sessionTitle.rename → 索引刷新显示新名称')

// ── 空标题拒绝 ──────────────────────────────────────────────────────
const rnBlank = await callHandler(renameRoute.handler, '/better-interface/rename', { method: 'POST', body: { sessionId: 'branch-a', title: '   ' } })
assert.equal(rnBlank.status, 400, '空标题应 400')
assert.equal(rnBlank.payload.code, 'TITLE_INVALID')
ok('空标题拒绝', 'title 全空白 → TITLE_INVALID')

// ── 缺 sessionId ────────────────────────────────────────────────────
const rnNoId = await callHandler(renameRoute.handler, '/better-interface/rename', { method: 'POST', body: { title: 'x' } })
assert.equal(rnNoId.status, 400)
assert.equal(rnNoId.payload.code, 'BAD_REQUEST')
ok('缺 sessionId 拒绝', 'BAD_REQUEST')

// ── 非法 JSON body ──────────────────────────────────────────────────
const badBody = await (async () => {
  const req = new EventEmitter()
  req.method = 'POST'
  req.headers = { host: 'localhost:3080' }
  req.url = '/better-interface/rename'
  let status, payload
  const res = { writeHead: (s) => { status = s }, end: (t) => { payload = JSON.parse(t) } }
  const p = renameRoute.handler(req, res)
  req.emit('data', Buffer.from('{not json'))
  req.emit('end')
  await p
  return { status, payload }
})()
assert.equal(badBody.status, 400)
assert.equal(badBody.payload.code, 'BAD_REQUEST')
ok('非法 JSON 拒绝', 'BAD_REQUEST')

// ── 未知 session → 404 ──────────────────────────────────────────────
const rnGhost = await callHandler(renameRoute.handler, '/better-interface/rename', { method: 'POST', body: { sessionId: 'ghost', title: 'x' } })
assert.equal(rnGhost.status, 404, '未知 session 应 404')
assert.equal(rnGhost.payload.code, 'SESSION_NOT_FOUND')
ok('非法 sessionId 拒绝', '持久化中也不存在 → 404')

// ── Cold session → 明确错误（不自动 resume）──────────────────────────
const rnCold = await callHandler(renameRoute.handler, '/better-interface/rename', { method: 'POST', body: { sessionId: 'branch-cold', title: 'x' } })
assert.equal(rnCold.status, 400, 'cold rename 应 400')
assert.equal(rnCold.payload.code, 'SESSION_NOT_LIVE')
assert.equal(rnCold.payload.error, '请先打开该 Branch 后再重命名', 'cold 提示文案明确')
assert.equal(renameCalls.length, 1, 'cold 不应调用 sessionTitle.rename（不自动 resume）')
ok('Cold Rename 拒绝', '提示请先打开该 Branch，不自动 resume')

// ── sessionTitle 服务缺失 → 安全降级 ─────────────────────────────────
const routes5 = []
const ctxNoTitles = {
  sessions: { get: (id) => (id === 'session-test' ? { id, events: fixtureEvents, firstLiveSeq: 0 } : undefined), list: () => [branchA] },
  sessionPersistence: { list: async () => [], inspect: async () => ({ meta: {}, events: [] }) },
  webServer: { register: (route) => { routes5.push(route); return () => {} } },
  effect: () => () => {},
  logger: { info: () => {}, warn: () => {} },
}
await apply(ctxNoTitles, { previewChars: 30 })
const renameRouteNoT = routes5.find((r) => r.path === '/better-interface/rename')
const rnNoT = await callHandler(renameRouteNoT.handler, '/better-interface/rename', { method: 'POST', body: { sessionId: 'session-test', title: 'x' } })
assert.equal(rnNoT.status, 503, '无 sessionTitle 服务 → 503')
assert.equal(rnNoT.payload.code, 'RENAME_UNAVAILABLE')
// 索引仍可用（安全降级）
const idxNoT = await callHandler(routes5.find((r) => r.path === '/better-interface/session').handler, '/better-interface/session?sessionId=session-test')
assert.equal(idxNoT.status, 200, '索引不受 rename 降级影响')
ok('sessionTitle 缺失降级', '503 + 索引照常')

// ── loopback / method 守卫（rename）──────────────────────────────────
const rnF = await callHandler(renameRoute.handler, '/better-interface/rename', { method: 'POST', body: { sessionId: 'branch-a', title: 'x' }, host: 'evil.example.com' })
assert.equal(rnF.status, 403, '非 loopback 应 403')
const rnM = await callHandler(renameRoute.handler, '/better-interface/rename', { method: 'GET' })
assert.equal(rnM.status, 405, 'GET 到 rename 应 405')
ok('loopback + method 守卫（rename）', '403 / 405')

// ══ Phase 6：GET /better-interface/session-location ══
// ── live session → 200（path/folder/kind/live=true）─────────────────
const locLive = await callHandler(locationRoute.handler, '/better-interface/session-location?sessionId=branch-a')
assert.equal(locLive.status, 200, 'live session location 应 200')
assert.equal(locLive.payload.sessionId, 'branch-a')
assert.equal(locLive.payload.live, true, 'live session 应标记 live=true')
assert.equal(locLive.payload.kind, 'jsonl')
assert.ok(locLive.payload.path.endsWith('session-branch-a\\session.jsonl.zstd'), 'path 为会话文件绝对路径')
assert.ok(locLive.payload.folder.endsWith('session-branch-a'), 'folder 为文件所在目录（dirname）')
ok('location live', 'live session → locate() → { path, folder, kind, live }')

// ── cold session → 200（header 来自 persistence.list，live=false）─────
const locCold = await callHandler(locationRoute.handler, '/better-interface/session-location?sessionId=branch-cold')
assert.equal(locCold.status, 200, 'cold session location 应 200')
assert.equal(locCold.payload.live, false, 'cold session 应标记 live=false')
assert.ok(locCold.payload.path.endsWith('session-branch-cold\\session.jsonl.zstd'), 'cold 文件路径可定位')
ok('location cold', 'cold session → persistence.list 找 header → locate（不 resume 不 open）')

// ── 404 / 400 / 403 / 405 ───────────────────────────────────────────
const locNf = await callHandler(locationRoute.handler, '/better-interface/session-location?sessionId=ghost')
assert.equal(locNf.status, 404, '未知 session 应 404')
assert.equal(locNf.payload.code, 'SESSION_NOT_FOUND')
const locB1 = await callHandler(locationRoute.handler, '/better-interface/session-location')
assert.equal(locB1.status, 400, '缺 sessionId 应 400')
const locF = await callHandler(locationRoute.handler, '/better-interface/session-location?sessionId=branch-a', { host: 'evil.example.com' })
assert.equal(locF.status, 403, '非 loopback 应 403')
const locM = await callHandler(locationRoute.handler, '/better-interface/session-location?sessionId=branch-a', { method: 'POST', body: {} })
assert.equal(locM.status, 405, 'POST 到 location 应 405')
ok('location 守卫', '404 / 400 / 403 / 405')

// ── 降级：persistence 无 locate → 503 LOCATION_UNAVAILABLE ───────────
const routes6 = []
const ctxNoLocate = {
  sessions: { get: (id) => (id === 'session-test' ? { id, header: { id, parentSession: undefined }, events: fixtureEvents } : undefined), list: () => [] },
  sessionPersistence: { list: async () => [], inspect: async () => ({ meta: {}, events: [] }) },   // 无 locate
  sessionTitle: ctxStub.sessionTitle,
  webServer: { register: (route) => { routes6.push(route); return () => {} } },
  effect: () => () => {},
  logger: { info: () => {}, warn: () => {} },
}
await apply(ctxNoLocate, { previewChars: 30 })
const locationNoL = routes6.find((r) => r.path === '/better-interface/session-location')
const locNoL = await callHandler(locationNoL.handler, '/better-interface/session-location?sessionId=session-test')
assert.equal(locNoL.status, 503, 'persistence 无 locate → 503')
assert.equal(locNoL.payload.code, 'LOCATION_UNAVAILABLE')
// 索引端点不受影响（安全降级）
const idxNoL = await callHandler(routes6.find((r) => r.path === '/better-interface/session').handler, '/better-interface/session?sessionId=session-test')
assert.equal(idxNoL.status, 200, '索引不受 location 降级影响')
ok('location 降级', '无 locate → 503 LOCATION_UNAVAILABLE，索引照常')

// ══ Phase 6：GET /better-interface/manage-sessions + POST /session-state ══
// ── domainSpec：单元名必须匹配 storage 的 UNIT_NAME_RE（/^[a-z][a-z0-9_]*$/）──
//    不能用连字符（better-interface 非法 → storageDomain.open 抛错 → 状态管理 503）
assert.match(domainSpec.name, /^[a-z][a-z0-9_]*$/, 'domain name 必须匹配 UNIT_NAME_RE（无连字符）')
assert.equal(domainSpec.tables.sessions.valueSchema.parse({ state: 'hidden' }).state, 'hidden', 'valueSchema.parse 可用')
ok('domainSpec 合规', 'name=better_interface 匹配 UNIT_NAME_RE（官方 message_feedback 同款下划线）')
// ── manage-sessions：全量会话（live+cold 合并）+ 状态（缺省 active）─────
const mg = await callHandler(manageRoute.handler, '/better-interface/manage-sessions')
assert.equal(mg.status, 200, 'manage-sessions 应 200')
assert.ok(Array.isArray(mg.payload.sessions), '应返回 sessions 数组')
const mgIds = mg.payload.sessions.map((s) => s.sessionId)
assert.ok(mgIds.includes('session-test') && mgIds.includes('branch-cold') && mgIds.includes('branch-a'), 'live+cold 全量合并')
const mgSessionTest = mg.payload.sessions.find((s) => s.sessionId === 'session-test')
assert.equal(mgSessionTest.state, 'active', '未设置状态 → 缺省 active')
assert.equal(mgSessionTest.live, true, 'live session 标记 live=true')
const mgCold = mg.payload.sessions.find((s) => s.sessionId === 'branch-cold')
assert.equal(mgCold.live, false, 'cold session 标记 live=false')
ok('manage-sessions', 'live+cold 全量列表 + 状态缺省 active + live 标记')

// ── session-state：切换状态 → 写 metadata + manage 反映 ────────────────
const st1 = await callHandler(stateRoute.handler, '/better-interface/session-state', { method: 'POST', body: { sessionId: 'branch-a', state: 'hidden' } })
assert.equal(st1.status, 200, '状态切换应 200')
assert.equal(st1.payload.ok, true)
assert.equal(st1.payload.state, 'hidden')
const mgAfter = await callHandler(manageRoute.handler, '/better-interface/manage-sessions')
const mgA = mgAfter.payload.sessions.find((s) => s.sessionId === 'branch-a')
assert.equal(mgA.state, 'hidden', '切换后 manage 反映新状态')
ok('session-state 切换', 'POST { sessionId, state } → metadata 持久化 + manage 反映')

// ── 守卫 / 校验：400 / 404 / 403 / 405 ────────────────────────────────
const stBad = await callHandler(stateRoute.handler, '/better-interface/session-state', { method: 'POST', body: { sessionId: 'branch-a', state: 'deleted' } })
assert.equal(stBad.status, 400, '非法 state 应 400')
assert.equal(stBad.payload.code, 'STATE_INVALID')
const stNoId = await callHandler(stateRoute.handler, '/better-interface/session-state', { method: 'POST', body: { state: 'active' } })
assert.equal(stNoId.status, 400, '缺 sessionId 应 400')
const stGhost = await callHandler(stateRoute.handler, '/better-interface/session-state', { method: 'POST', body: { sessionId: 'ghost', state: 'active' } })
assert.equal(stGhost.status, 404, '未知 session 应 404')
const stF = await callHandler(stateRoute.handler, '/better-interface/session-state', { method: 'POST', body: { sessionId: 'branch-a', state: 'active' }, host: 'evil.example.com' })
assert.equal(stF.status, 403, '非 loopback 应 403')
const stM = await callHandler(stateRoute.handler, '/better-interface/session-state', { method: 'GET' })
assert.equal(stM.status, 405, 'GET 到 state 应 405')
const mgM = await callHandler(manageRoute.handler, '/better-interface/manage-sessions', { method: 'POST', body: {} })
assert.equal(mgM.status, 405, 'POST 到 manage 应 405')
ok('state 守卫/校验', 'STATE_INVALID / 400 / 404 / 403 / 405')

// ── 降级：storageDomain 缺失 → manage 照常（active）、state 503 ────────
const routes7 = []
const ctxNoDomain = {
  sessions: { get: (id) => (id === 'session-test' ? { id, events: fixtureEvents } : undefined), list: () => [] },
  sessionPersistence: { list: async () => [], inspect: async () => ({ meta: {}, events: [] }), locate: () => undefined },
  sessionTitle: ctxStub.sessionTitle,
  webServer: { register: (route) => { routes7.push(route); return () => {} } },
  effect: () => () => {},
  logger: { info: () => {}, warn: () => {} },
  // 无 storageDomain
}
await apply(ctxNoDomain, { previewChars: 30 })
const mgNoD = await callHandler(routes7.find((r) => r.path === '/better-interface/manage-sessions').handler, '/better-interface/manage-sessions')
assert.equal(mgNoD.status, 200, '无 storageDomain → manage 照常')
const stNoD = await callHandler(routes7.find((r) => r.path === '/better-interface/session-state').handler, '/better-interface/session-state', { method: 'POST', body: { sessionId: 'session-test', state: 'active' } })
assert.equal(stNoD.status, 503, '无 storageDomain → state 503')
assert.equal(stNoD.payload.code, 'STATE_UNAVAILABLE')
ok('state 降级', 'storageDomain 缺失 → 状态管理 503，列表照常')

// ══ Phase 6 联动：状态过滤作用于悬浮窗索引 ══
// 前置：上方 manage 测试已把 branch-a 设为 hidden。
const idxFiltered = await callHandler(sessionRoute.handler, '/better-interface/session?sessionId=session-test')
const fBranches = idxFiltered.payload.messages[0].branches
assert.equal(fBranches.some((b) => b.sessionId === 'branch-a'), false, 'hidden 的 Branch 从索引过滤')
assert.equal(fBranches.some((b) => b.sessionId === 'branch-title'), true, 'active 的 Branch 仍显示')
assert.equal(fBranches.some((b) => b.sessionId === 'branch-d'), true, 'active 的 Branch 仍显示')
assert.equal(idxFiltered.payload.messages[1].branches.length, 1, 'cold Branch（active）仍显示')
ok('索引过滤 hidden', 'hidden 的 Branch 从悬浮窗索引消失，其余照常')

// 恢复 branch-a → 重新出现
await callHandler(stateRoute.handler, '/better-interface/session-state', { method: 'POST', body: { sessionId: 'branch-a', state: 'active' } })
const idxRestored = await callHandler(sessionRoute.handler, '/better-interface/session?sessionId=session-test')
assert.equal(idxRestored.payload.messages[0].branches.some((b) => b.sessionId === 'branch-a'), true, '恢复后 Branch 重新出现')
ok('恢复联动', '切回 active → Branch 回到索引')

// ── archived 会话在 manage-sessions 中可见（管理界面不丢归档）──────────
await callHandler(stateRoute.handler, '/better-interface/session-state', { method: 'POST', body: { sessionId: 'branch-cold', state: 'archived' } })
const mgArch = await callHandler(manageRoute.handler, '/better-interface/manage-sessions')
const archRow = mgArch.payload.sessions.find((s) => s.sessionId === 'branch-cold')
assert.ok(archRow, 'archived 会话应出现在 manage-sessions 列表')
assert.equal(archRow.state, 'archived', '状态为 archived')
// 索引联动：archived 的 Branch 从索引过滤（与 hidden 一致）
const idxArch = await callHandler(sessionRoute.handler, '/better-interface/session?sessionId=session-test')
assert.equal(idxArch.payload.messages[1].branches.some((b) => b.sessionId === 'branch-cold'), false, 'archived 的 Branch 从索引过滤')
// 恢复 archived → 索引重现
await callHandler(stateRoute.handler, '/better-interface/session-state', { method: 'POST', body: { sessionId: 'branch-cold', state: 'active' } })
ok('archived 可见性', 'manage 列表含 archived；索引过滤 archived；恢复后重现')

// ══ Phase 6：原生归档联动（workspaceRegistry.archivedSessionIds）══
nativeArchivedIds = ['branch-a']
const mgNative = await callHandler(manageRoute.handler, '/better-interface/manage-sessions')
const nativeRow = mgNative.payload.sessions.find((s) => s.sessionId === 'branch-a')
assert.ok(nativeRow, '原生归档会话在 manage 列表可见')
assert.equal(nativeRow.state, 'archived', '原生归档 → state=archived')
assert.equal(nativeRow.nativeArchived, true, '标记 nativeArchived=true')
// 索引过滤：原生归档的 branch 从索引消失
const idxNative = await callHandler(sessionRoute.handler, '/better-interface/session?sessionId=session-test')
assert.equal(idxNative.payload.messages[0].branches.some((b) => b.sessionId === 'branch-a'), false, '原生归档 branch 从索引过滤')
// 原生归档不可经插件切换状态
const stNative = await callHandler(stateRoute.handler, '/better-interface/session-state', { method: 'POST', body: { sessionId: 'branch-a', state: 'active' } })
assert.equal(stNative.status, 400, '原生归档不可切换')
assert.equal(stNative.payload.code, 'NATIVE_ARCHIVED')
nativeArchivedIds = []
ok('原生归档联动', 'manage 可见（archived+nativeArchived）；索引过滤；切换拒绝')

// ══ DSH ≥ v0.2 形状兼容：list() 返回快照 + 无 inspect（open/read 读冷分支）══
const coldV2Events = {
  'branch-cold': eventsCold,
  'branch-a1': eventsA1,
  'branch-a1-1': eventsA1_1,
  'branch-d': [userMessage(0, 'seed 继承'), userMessage(1, 'seed 继承'), userMessage(2, 'cold 版本文本')],
  'branch-title': eventsTitle,
}
const snapshotOf = (header) => ({ header, formatStatus: 'current', revision: 'rev-' + header.id, sizeBytes: 1024 })
const v2HeaderOf = (id) => ({
  id,
  parentSession: id === 'branch-a1' ? 'branch-a' : id === 'branch-a1-1' ? 'branch-a1' : 'session-test',
  seedLength: id === 'branch-cold' ? 7 : id === 'branch-a1' ? 3 : id === 'branch-a1-1' ? 5 : 2,
})
const routesV2 = []
const ctxV2 = {
  sessions: {
    // 0.2：Session 只暴露 snapshotEvents()，.events 已是私有日志
    get: (id) => (id === 'session-test'
      ? { id, header: { id: 'session-test' }, firstLiveSeq: 0, snapshotEvents: () => fixtureEvents }
      : id === 'branch-a' ? { id, header: branchA.header, firstLiveSeq: 2, snapshotEvents: () => eventsA } : undefined),
    list: () => [
      { id: 'branch-a', header: branchA.header, firstLiveSeq: 2, snapshotEvents: () => eventsA },
      { id: 'session-test', header: { id: 'session-test' }, firstLiveSeq: 0, snapshotEvents: () => fixtureEvents },
    ],
  },
  sessionPersistence: {
    locate: (meta) => ({ kind: 'jsonl', path: 'C:\\sessions\\' + meta.id + '\\session.v4.jsonl.zstd' }),
    list: async () => Object.keys(coldV2Events).map((id) => snapshotOf(v2HeaderOf(id))),
    // 0.2：无 inspect；只读 handle 读取事件（read 不取所有权）
    open: async (id, access) => {
      const events = coldV2Events[id]
      if (!events) throw new Error('not found')
      return { id, access, header: v2HeaderOf(id), read: async () => ({ events, eventState: 'owned' }), close: async () => {} }
    },
  },
  sessionTitle: ctxStub.sessionTitle,
  storageDomain: ctxStub.storageDomain,
  workspaceRegistry: ctxStub.workspaceRegistry,
  webServer: { register: (route) => { routesV2.push(route); return () => {} } },
  effect: () => () => {},
  logger: { info: () => {}, warn: () => {} },
}
await apply(ctxV2, { previewChars: 30 })
const v2Route = (path) => routesV2.find((r) => r.path === path)
// 1) list() 快照结构 → manage 能看到冷会话
const mgV2 = await callHandler(v2Route('/better-interface/manage-sessions').handler, '/better-interface/manage-sessions')
const mgV2Ids = mgV2.payload.sessions.map((s) => s.sessionId)
assert.ok(mgV2Ids.includes('branch-cold'), '0.2 快照式 list() → cold 会话可见')
assert.equal(mgV2.payload.sessions.find((s) => s.sessionId === 'branch-cold').live, false, 'cold 标记 live=false')
assert.ok(mgV2Ids.includes('session-test'), 'live 会话仍在')
// 2) cold 分支：无 inspect，经 open(id, read).read() 读取
const idxV2 = await callHandler(v2Route('/better-interface/session').handler, '/better-interface/session?sessionId=session-test')
assert.equal(idxV2.payload.messages.length, 2, '0.2 live session 事件经 snapshotEvents() 读取（.events 私有）')
const liveBranchV2 = idxV2.payload.messages[0].branches.find((b) => b.sessionId === 'branch-a')
assert.ok(liveBranchV2, '0.2 live 分支仍被发现（snapshotEvents）')
const coldV2 = idxV2.payload.messages[1].branches.find((b) => b.sessionId === 'branch-cold')
assert.ok(coldV2, '0.2 冷分支应被发现（open/read）')
assert.equal(coldV2.text, '换一种架构实现', '冷分支文本推导正确')
// 3) location：快照 header → locate（cold）
const locV2 = await callHandler(v2Route('/better-interface/session-location').handler, '/better-interface/session-location?sessionId=branch-cold')
assert.equal(locV2.status, 200, '0.2 快照式 list() → cold 会话可定位')
assert.ok(String(locV2.payload.path).includes('branch-cold'), '定位路径使用 cold header')
// 4) rename：cold 会话经快照 list 识别 → SESSION_NOT_LIVE（而不是 404）
const rnV2 = await callHandler(v2Route('/better-interface/rename').handler, '/better-interface/rename', { method: 'POST', body: { sessionId: 'branch-cold', title: '新名称' } })
assert.equal(rnV2.status, 400, '0.2 cold 会话 rename → 400')
assert.equal(rnV2.payload.code, 'SESSION_NOT_LIVE', '识别为 cold（非 404）')
ok('DSH 0.2 形状兼容', 'list() 快照 / 无 inspect（open read）/ cold location+rename 识别')

// ── 模块导出：inject 声明正确 ────────────────────────────────────────
const mod = await import('./index.js')
assert.deepEqual(mod.inject, ['webServer', 'sessions', 'sessionPersistence', 'sessionTitle', 'storageDomain', 'workspaceRegistry'], 'inject 应含 6 个服务')
assert.equal(mod.name, 'dsh-better-interface')
ok('模块导出', 'inject=[webServer, sessions, sessionPersistence, sessionTitle, storageDomain, workspaceRegistry]')

console.log('\n结果: ' + passed + ' 项断言全部通过')
