/**
 * dsh-better-interface — Phase 2.1 + 3 + 4 + 4.1 + 5 + 5.1 structural smoke test.
 *
 *   node smoke-test.mjs
 *
 * Client bundle structural sim (no real DOM/React). The Rail registers in
 * shell.overlay, renders the right-edge button (3 dots) and
 * a PERSISTENT hover panel listing the fetched message index (oldest first,
 * text only), Phase 3 click-to-locate, Phase 4 branch toggles (○/●) that
 * expand per-message branch lists and open branch sessions via the native
 * ctx.sessions.open(id), Phase 4.1 current-switch index refresh with child
 * branches, Phase 5 branch name display + inline rename (✎ → input + ✓/✕),
 * and Phase 5.1 edit-lock + open-scroll-to-bottom behaviors.
 */
import assert from 'node:assert/strict'

let passed = 0
function ok(name, detail) {
  passed += 1
  console.log('  ✓ ' + name + (detail !== undefined ? ' — ' + detail : ''))
}

// ── DOM / element stubs ────────────────────────────────────────────────
const scrolled = []
const domRows = {}   // selector -> element
function makeRow() { return { scrollIntoView: (opts) => { scrolled.push(opts) } } }
const documentStub = {
  querySelector: (sel) => {
    if (sel.indexOf('style[data-plugin-css="') === 0) return null
    return domRows[sel] !== undefined ? domRows[sel] : null
  },
  createElement: (tag) => (tag === 'style' ? { dataset: {}, textContent: '' } : {}),
  head: { appendChild: () => {} },
}
const styleTags = []
documentStub.head.appendChild = (el) => { styleTags.push(el) }

const registrations = []
const slotsStub = {
  inject: (name, callback) => {
    registrations.push({ name, callback })
    callback()
    return () => {}
  },
  register: (options, component) => {
    registrations.push({ registered: options, component })
    return () => {}
  },
}

// ── fake 会话快照 / 定位 session / open spy ────────────────────────────
const openedSessions = []
function makeSnapshot(nodes) {
  return { chat: { nodes: { values: () => nodes } } }
}
function makeNode(anchorSeq, key) {
  return { key: key !== undefined ? key : ('node-' + anchorSeq), anchorSeq, kind: 'user', data: {} }
}
function makePagedSession(pages) {
  let index = 0
  const calls = { loadOlder: 0 }
  return {
    calls,
    getSnapshot: () => makeSnapshot(pages[Math.min(index, pages.length - 1)]),
    loadOlder: async () => {
      calls.loadOlder += 1
      if (index < pages.length - 1) index += 1
    },
  }
}
const directSession = {
  getSnapshot: () => makeSnapshot([makeNode(1), makeNode(5)]),
  loadOlder: async () => {},
}
const ctxStub = {
  slots: slotsStub,
  sessions: {
    open: (id) => { openedSessions.push(id) },
    binding: (id) => (id === 's2' ? { session: directSession } : undefined),
  },
}

const seed = []
const ReactStub = {
  _hookIndex: 0,
  _effects: [],
  __reset() { this._hookIndex = 0; this._effects = []; seed.length = 0 },
  useState(init) {
    const i = this._hookIndex++
    if (seed[i] === undefined) seed[i] = init
    const set = (v) => { seed[i] = typeof v === 'function' ? v(seed[i]) : v }
    return [seed[i], set]
  },
  useRef(init) { const i = this._hookIndex++; if (seed[i] === undefined) seed[i] = { current: init }; return seed[i] },
  useEffect(cb, deps) { this._effects.push({ cb, deps }); this._hookIndex++ },
  createElement(type, props, ...children) {
    const el = { type, props: props || {}, children: children.flat() }
    if (props && props.ref) props.ref.current = el   // 模拟 React ref 绑定
    return el
  },
}
// 每次渲染前重置 hook 游标（模拟 React 渲染时 hooks 从头按序执行；seed 保留状态）
function renderRail(props) {
  ReactStub._hookIndex = 0
  return overlayReg.component(props)
}
// 遍历元素树查找类名（避免 JSON.stringify 遇 ref 循环）
function treeHasClass(root, cls) {
  const stack = [root]
  while (stack.length > 0) {
    const node = stack.pop()
    if (node === null || node === undefined || typeof node === 'string') continue
    if (node.props && typeof node.props.className === 'string' && node.props.className.indexOf(cls) !== -1) return true
    if (Array.isArray(node.children)) {
      for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i])
    }
  }
  return false
}

const windowStub = {
  __ModuleLoader__: {
    load: (entry) => { windowStub.loadedEntry = entry },
  },
}

globalThis.window = windowStub
globalThis.document = documentStub
await import('./lib/client.js')
const entry = windowStub.loadedEntry
assert.ok(entry && typeof entry.factory === 'function', 'bundle 必须调用 __ModuleLoader__.load')
const exportsObj = entry.factory((name) => {
  if (name === 'react') return ReactStub
  throw new Error('unexpected require: ' + name)
})
assert.equal(typeof exportsObj.apply, 'function')
assert.ok(Array.isArray(exportsObj.inject) && exportsObj.inject.includes('slots'), 'inject 应含 slots')
assert.ok(exportsObj.inject.includes('sessions'), 'inject 应含 sessions（定位 + 打开 Branch）')
ok('bundle 工厂导出', 'apply + inject=[slots, sessions]')

exportsObj.apply(ctxStub)
const regCalls = registrations.filter((r) => r.registered !== undefined)
const overlayReg = regCalls.find((r) => r.registered.name === 'shell.overlay')
assert.ok(overlayReg, '必须注册 shell.overlay')
const priceReg = regCalls.find((r) => r.registered.name === 'sidebar.footer.action')
assert.equal(priceReg?.registered.id, 'price-monitor', '价格面板必须注册在侧栏底部')
assert.equal(regCalls.length, 3, '应注册会话入口、设置页和价格面板')
ReactStub.__reset()
const pricePanel = priceReg.component({ wide: false })
assert.equal(pricePanel.props['data-plugin'], entry.id, '价格面板由合并后的客户端拥有')
assert.ok(treeHasClass(pricePanel, 'pmo-rail'), '折叠侧栏保留价格面板')
assert.ok(styleTags.some((tag) => tag.dataset.pluginCss === entry.id + '/price-monitor.css'))
ok('槽位注册', 'shell.overlay + settings.section + sidebar.footer.action')

// hooks 顺序：0=hover, 1=timerRef, 2=data, 3=seqRef, 4=hoverRef, 5=expanded,
//            6=renamingSeq, 7=renameInput, 8=renameError, 9=popRef, 10=useEffect
const noSessionList = { ids: [], byId: {}, current: undefined }
const withSessionList = { ids: ['s1', 's2'], byId: { s1: {}, s2: {} }, current: 's2' }

// ── 无会话：按钮照常显示；popup 常驻但不可见（root 无 sbi-hover）───────
ReactStub.__reset()
const rootNone = renderRail({ useSessions: (sel) => sel(noSessionList) })
assert.equal(rootNone.props.className, 'sbi-root', '非 hover：root 类名不带 sbi-hover')
const button = rootNone.children[0]
assert.equal(button.type, 'button')
assert.equal(button.props.className, 'sbi-rail')
assert.equal(button.children.length, 3, '按钮应有 3 个圆圈作为 flex 子项')
button.children.forEach((dot) => {
  assert.equal(dot.type, 'span')
  assert.equal(dot.props.className, 'sbi-dot')
})
assert.equal(rootNone.children[1].props.className, 'sbi-pop', 'popup 常驻 DOM（不按 hover 插入/移除）')
ok('Rail 渲染', 'sbi-rail(3 圆圈) 始终显示，sbi-pop 常驻')

// ── 当前会话识别（DSH ≥ v0.2）：SessionListState 无 current → mainView 标记 ──
const X = exportsObj.__test
const mainViewState = {
  ids: ['s1', 's2'],
  byId: { s1: { retainedBy: {} }, s2: { retainedBy: { mainView: 1 } } },
}
assert.equal(X.currentSessionIdOf(withSessionList), 's2', '旧版 current 字段优先')
assert.equal(X.currentSessionIdOf(mainViewState), 's2', '0.2 由 retainedBy.mainView 推导')
assert.equal(X.currentSessionIdOf({ ids: [], byId: {} }), undefined, '无当前会话 → undefined')
assert.equal(X.currentSessionIdOf(null), undefined, 'null 状态 → undefined')
ReactStub.__reset()
seed[0] = true
const derivedRoot = renderRail({ useSessions: (sel) => sel(mainViewState) })
const derivedEffect = ReactStub._effects.find((e) => Array.isArray(e.deps))
assert.ok(derivedEffect, 'current 派生后应注册 useEffect([current])')
assert.equal(derivedEffect.deps[0], 's2', 'effect 依赖 = 推导出的当前会话 id（无 current 字段也生效）')
ok('当前会话识别', 'DSH 0.2 mainView 标记 / 旧版 current 双兼容')

// ── 无会话 + hover：窗口内容"暂无对话数据" ──────────────────────────
ReactStub.__reset()
seed[0] = true
const popNone = renderRail({ useSessions: (sel) => sel(noSessionList) })
assert.equal(popNone.props.className, 'sbi-root sbi-hover')
assert.equal(popNone.children[1].children[1].children[0], '暂无对话数据')
ok('无会话提示', '窗口显示"暂无对话数据"')

// ── 有会话 + ready（含 branches）：渲染正序文本 + 展开按钮 ────────────
const readyMessages = [
  { seq: 1, text: '第一条用户消息', branches: [{ sessionId: 'branch-a', parentSessionId: 's2', text: '使用 seed 创建分支', seedLength: 2 }] },
  { seq: 5, text: '第二条用户消息很长很长很长很长很长很长很长', branches: [] },
]
ReactStub.__reset()
seed[0] = true   // hover
seed[2] = { status: 'ready', messages: readyMessages, error: null }
const popReady = renderRail({ useSessions: (sel) => sel(withSessionList) })
assert.equal(popReady.props.className, 'sbi-root sbi-hover')
const ready = popReady.children[1]
const items = ready.children.slice(1)   // [0] 是标题
assert.equal(items.length, 2, '窗口应含 2 条消息')
// 条目 1：text + toggle（● 深色）
assert.equal(items[0].props.className, 'sbi-item')
assert.equal(items[0].children[0].props.className, 'sbi-item-text')
assert.equal(items[0].children[0].children[0], '第一条用户消息')
const toggle1 = items[0].children[1]
assert.equal(toggle1.type, 'button')
assert.ok(toggle1.props.className.indexOf('sbi-branch-toggle') !== -1, '条目 1 应有展开按钮')
assert.ok(toggle1.props.className.indexOf('sbi-branch-toggle-on') !== -1, '有 Branch → toggle 深色(on)')
assert.equal(toggle1.children[0], '●', '有 Branch → ●')
// 条目 2：无 branch → ○ 浅色
const toggle2 = items[1].children[1]
assert.ok(toggle2.props.className.indexOf('sbi-branch-toggle') !== -1)
assert.equal(toggle2.props.className.indexOf('sbi-branch-toggle-on'), -1, '无 Branch → toggle 浅色')
assert.equal(toggle2.children[0], '○', '无 Branch → ○')
ok('索引条目 + 展开按钮', '有 Branch → ●(on)，无 Branch → ○，文本单行')

// ── 展开：点击 ● toggle → branch-list 出现在条目下 ────────────────────
let stopCount = 0
const stopSpy = () => { stopCount += 1 }
toggle1.props.onClick({ stopPropagation: stopSpy })
assert.equal(stopCount, 1, 'toggle 点击应 stopPropagation')
assert.equal(scrolled.length, 0, 'toggle 点击不应触发消息跳转')
// 重新渲染：expandedSeq 已更新（seed[5] = 1）
const popExpanded = renderRail({ useSessions: (sel) => sel(withSessionList) })
const expChildren = popExpanded.children[1].children
const branchList = expChildren.find((c) => c && c.props && c.props.className === 'sbi-branch-list')
assert.ok(branchList, '展开后应出现 branch-list')
const branchItem = branchList.children[0]
assert.equal(branchItem.props.className, 'sbi-branch-item')
assert.equal(branchItem.children[0].props.className, 'sbi-branch-mark')
assert.equal(branchItem.children[0].children[0], '└')
assert.equal(branchItem.children[1].children[0], '使用 seed 创建分支', 'Branch 文本渲染')
ok('展开 Branch 列表', '● toggle → 条目下方缩进显示 branch-item（└ + 文本）')

// ── Branch 点击 → 原生打开对应 Session ─────────────────────────────────
openedSessions.length = 0
branchItem.props.onClick({ stopPropagation: () => { stopCount += 1 } })
assert.deepEqual(openedSessions, ['branch-a'], '点击 Branch 应 ctx.sessions.open(branch-a)（旧版回退）')
ok('Branch 点击切换（旧版回退）', 'onClick → ctx.sessions.open(sessionId)')

// ── Branch 点击（DSH ≥ v0.2）：导航走 ctx.get('uiWorkspace').openSession ──
const openedViaWorkspace = []
ctxStub.get = (name) => (name === 'uiWorkspace' ? { openSession: (id) => { openedViaWorkspace.push(id) } } : undefined)
openedSessions.length = 0
ReactStub.__reset()
seed[0] = true
seed[2] = { status: 'ready', messages: readyMessages, error: null }
const wsRoot = renderRail({ useSessions: (sel) => sel(withSessionList) })
const wsToggle = wsRoot.children[1].children[1].children[1]
wsToggle.props.onClick({ stopPropagation: () => {} })
const wsExpanded = renderRail({ useSessions: (sel) => sel(withSessionList) })
const wsBranchList = wsExpanded.children[1].children.find((c) => c && c.props && c.props.className === 'sbi-branch-list')
assert.ok(wsBranchList, '新通道下 Branch 列表可展开')
wsBranchList.children[0].props.onClick({ stopPropagation: () => {} })
assert.deepEqual(openedViaWorkspace, ['branch-a'], '新导航通道 openSession(branch-a)')
assert.equal(openedSessions.length, 0, '新通道存在时不走旧 sessions.open')
// 新通道缺失（旧 DSH）→ openSessionNative 回退 ctx.sessions.open
delete ctxStub.get
openedSessions.length = 0
assert.equal(X.openSessionNative(ctxStub, 'branch-a'), true, '旧版回退成功')
assert.deepEqual(openedSessions, ['branch-a'], '无 uiWorkspace 时回退 ctx.sessions.open')
// 两通道都缺失 → 返回 false（调用方只打 Console 错误，不崩溃）
assert.equal(X.openSessionNative({ sessions: {} }, 'branch-a'), false, '双通道缺失 → false')
ok('Branch 点击切换（新导航）', 'ctx.get(uiWorkspace).openSession(id)；旧版回退 ctx.sessions.open')

// ── 收起：再次点击 toggle → branch-list 消失 ──────────────────────────
const popCollapsed = renderRail({ useSessions: (sel) => sel(withSessionList) })
const colToggle = popCollapsed.children[1].children[1].children[1]
colToggle.props.onClick({ stopPropagation: () => {} })
const popCollapsed2 = renderRail({ useSessions: (sel) => sel(withSessionList) })
const col2Children = popCollapsed2.children[1].children
assert.equal(col2Children.some((c) => c && c.props && c.props.className === 'sbi-branch-list'), false, '再次点击 → 收起')
ok('Branch 收起', '再次点击 toggle → branch-list 消失')

// ── 无 Branch 消息：点击 ○ 无效果 ─────────────────────────────────────
const popNoBr = renderRail({ useSessions: (sel) => sel(withSessionList) })
const noBrItems = popNoBr.children[1].children.slice(1)
const noBrToggle = noBrItems[1].children[1]
const beforeCount = scrolled.length
noBrToggle.props.onClick({ stopPropagation: () => {} })
const popNoBr2 = renderRail({ useSessions: (sel) => sel(withSessionList) })
const noBrChildren = popNoBr2.children[1].children
assert.equal(noBrChildren.some((c) => c && c.props && c.props.className === 'sbi-branch-list'), false, '无 Branch → 点击 ○ 不展开')
assert.equal(scrolled.length, beforeCount, '点击 ○ 不触发跳转')
ok('无 Branch 容错', '○ 点击无效果，不展开不跳转')

// ── 有会话但无消息：显示"暂无用户消息" ──────────────────────────────
ReactStub.__reset()
seed[0] = true
seed[2] = { status: 'ready', messages: [], error: null }
const popEmpty = renderRail({ useSessions: (sel) => sel(withSessionList) })
assert.equal(popEmpty.children[1].children[1].children[0], '暂无用户消息')
ok('无消息提示', '窗口显示"暂无用户消息"')

// ── CSS 注入 + 作用域 + Phase 4 规则 ──────────────────────────────────
assert.ok(styleTags.length >= 1, '应注入 <style data-plugin>')
const styleText = styleTags[0].textContent || ''
assert.ok(styleText.indexOf('.sbi-rail') !== -1 && styleText.indexOf('.sbi-pop') !== -1, '样式表含 Rail/Popup')
assert.ok(styleText.indexOf('.sbi-root.sbi-hover .sbi-pop{opacity:1') !== -1, 'hover 类显隐 popup')
assert.ok(styleText.indexOf('.sbi-rail::after{content') !== -1, 'rail ::after 缝隙桥接')
assert.equal(styleText.indexOf('@keyframes sbi-pop-in'), -1, '无位移动画')
assert.ok(styleText.indexOf('text-overflow:ellipsis') !== -1, '条目单行省略')
assert.ok(styleText.indexOf('.sbi-branch-toggle{') !== -1, '样式表含 toggle 规则')
assert.ok(styleText.indexOf('.sbi-branch-toggle-on{color:var(--dsw-alias-accent') !== -1, 'toggle on 深色')
assert.ok(styleText.indexOf('.sbi-branch-list{margin') !== -1, '样式表含 branch-list 规则')
assert.ok(styleText.indexOf('.sbi-branch-item:hover{background') !== -1, 'branch-item hover 灰白边框')
const badSameElement = /\[data-plugin=\"dsh-better-interface\"\]\.sbi-(rail|dot|pop|pop-head|hint|item|branch-toggle|branch-list|branch-item)\s*\{/.test(styleText)
assert.equal(badSameElement, false, '子元素规则不得用同一元素选择器')
ok('CSS 注入 + 作用域', '常驻显隐 / 桥接 / 单行省略 / toggle+branch 规则 / 后代选择器防回归')

// ══ Phase 6.5：长消息折叠（CSS + 纯逻辑）══
assert.ok(styleText.indexOf('.sbi-fold{position:relative;overflow:hidden}') !== -1, '折叠 class（通用）规则')
assert.ok(styleText.indexOf('.sbi-fold::after{content:"";') !== -1, '折叠渐变遮罩规则')
assert.ok(styleText.indexOf('.sbi-fold-btn{position:absolute;left:10px') !== -1, '展开按钮规则（左下角）')
const F = exportsObj.__test
assert.equal(typeof F.foldNeeded, 'function', '应导出 foldNeeded')
assert.equal(typeof F.setFolded, 'function', '应导出 setFolded')
assert.equal(typeof F.findBubble, 'function', '应导出 findBubble')
// 气泡特征：背景+圆角 优先；无特征时 fallback 最大含文本块
const bubbleLike = { textContent: '气泡文本', scrollHeight: 220, backgroundColor: 'rgb(240, 240, 240)', borderRadius: '22px' }
const stubRow = {
  querySelectorAll: () => [
    { textContent: '   ', scrollHeight: 5 },
    { textContent: '短文本', scrollHeight: 40 },
    bubbleLike,
    { textContent: '', scrollHeight: 500 },
  ],
}
globalThis.getComputedStyle = (el) => ({ lineHeight: '20px', backgroundColor: el.backgroundColor, borderRadius: el.borderRadius })
assert.equal(F.findBubble(stubRow), bubbleLike, '带背景+圆角的气泡被选中')
assert.equal(F.findBubble({ querySelectorAll: () => [] }), null, '无元素返回 null')
// 无特征时 fallback 最大含文本块
globalThis.getComputedStyle = () => ({ lineHeight: '20px' })
const stubPlain = { querySelectorAll: () => [{ textContent: 'a', scrollHeight: 10 }, { textContent: '长文本', scrollHeight: 90 }] }
assert.equal(F.findBubble(stubPlain).scrollHeight, 90, '无特征 fallback 最大文本块')
globalThis.getComputedStyle = () => ({ lineHeight: '20px' })
assert.equal(F.foldNeeded({ scrollHeight: 200 }, 5), true, '内容高度 > 5 行 → 需折叠')
assert.equal(F.foldNeeded({ scrollHeight: 60 }, 5), false, '内容高度 <= 5 行 → 不折叠')
// 折叠行选择器：普通用户消息 + steering（排队/插话）都要覆盖；上下文注入不折叠
assert.ok(typeof F.foldRowSelector === 'string', '应导出 foldRowSelector')
assert.ok(F.foldRowSelector.includes('[data-chat-flow-kind="user"]'), '选择器覆盖用户消息')
assert.ok(F.foldRowSelector.includes('[data-chat-flow-kind="steering"]'), '选择器覆盖 steering（0.2 排队/插话消息）')
assert.equal(F.foldRowSelector.includes('"context"'), false, '上下文注入不折叠')
const foldEl = { style: {}, classList: { _set: new Set(), add(c) { this._set.add(c) }, remove(c) { this._set.delete(c) }, contains(c) { return this._set.has(c) } } }
F.setFolded(foldEl, true, 5)
assert.equal(foldEl.style.maxHeight, '100px', '折叠 max-height = 5 × 20px')
assert.equal(foldEl.classList.contains('sbi-fold'), true, '折叠 class 添加')
F.setFolded(foldEl, false, 5)
assert.equal(foldEl.style.maxHeight, '', '展开清除 max-height')
assert.equal(foldEl.classList.contains('sbi-fold'), false, '折叠 class 移除')
ok('长消息折叠', '文本块定位 + 行高判定 + 折叠/展开（3 行不误判）')

// ── 定位视图回退（DSH 0.2 的「轨迹」视图）────────────────────────────
assert.equal(typeof F.ensureChatView, 'function', '应导出 ensureChatView')
assert.equal(await F.ensureChatView(), false, '无视图 tab 时安全返回 false（不抛错）')
const mkTab = (label, selected) => ({
  textContent: label,
  getAttribute: (n) => (n === 'aria-selected' ? String(selected) : null),
})
const tabInfo = F.chatTabsOf({ querySelectorAll: () => [mkTab('轨迹', true), mkTab('对话', false)] })
assert.equal(tabInfo.active.label, '轨迹', '识别当前激活视图')
assert.equal(tabInfo.preferred[0].textContent, '对话', '优先选择对话视图 tab')
assert.equal(tabInfo.others.length, 1, '其余视图作为兜底候选')
ok('定位视图回退', '轨迹视图 → 优先切回对话；无 tab 安全返回')

// ══ Phase 6.6：侧栏 DOM 隐藏（标题精确匹配 + 隐藏/恢复）══
assert.equal(typeof F.titleInRow, 'function', '应导出 titleInRow')
assert.equal(typeof F.processSidebarRow, 'function', '应导出 processSidebarRow')
const sideRow = {
  style: {},
  _attrs: {},
  querySelectorAll: () => [{ textContent: '  ' }, { textContent: '  我的会话  ' }, { textContent: '5分钟' }],
  getAttribute: (k) => (k in sideRow._attrs ? sideRow._attrs[k] : null),
  setAttribute: (k, v) => { sideRow._attrs[k] = String(v) },
  removeAttribute: (k) => { delete sideRow._attrs[k] },
}
assert.equal(F.titleInRow(sideRow, '我的会话'), true, '行内 span 文本（trim 后）匹配标题')
assert.equal(F.titleInRow(sideRow, '别的会话'), false, '标题不匹配 → false')
assert.equal(F.titleInRow(null, 'x'), false, 'null 行 → false')
F.processSidebarRow(sideRow, ['我的会话'])
assert.equal(sideRow.style.display, 'none', 'hidden 标题匹配 → 行隐藏')
assert.equal(sideRow._attrs['data-sbi-sidebar-hidden'], '1', '打隐藏标记（区分 React 自身隐藏）')
F.processSidebarRow(sideRow, [])
assert.equal(sideRow.style.display, '', '不再 hidden → 取消隐藏')
assert.equal('data-sbi-sidebar-hidden' in sideRow._attrs, false, '隐藏标记移除')
F.processSidebarRow(sideRow, ['别的会话'])
assert.equal(sideRow.style.display, '', '非 hidden 标题 → 不动作')
ok('侧栏 DOM 隐藏', '标题精确匹配 + 隐藏/恢复（React 重建行由 observer 兜底）')

// ══ Phase 3：定位逻辑（exports.__test）══
const T = exportsObj.__test
assert.ok(T && typeof T.locateFromSession === 'function', '应导出定位内部函数')
const snapHit = makeSnapshot([makeNode(42, 'user:abc'), makeNode(50, 'assistant:def')])
assert.equal(T.findNodeBySeq(snapHit, 42).key, 'user:abc', 'anchorSeq 命中')
assert.equal(T.findNodeBySeq(snapHit, 999), null, '未命中 null')
assert.equal(T.minAnchorSeq(snapHit), 42, 'minAnchorSeq')
domRows['[data-chat-anchor-key="user:abc"]'] = makeRow()
assert.equal(T.scrollToNode(makeNode(42, 'user:abc')), true, 'scrollToNode 命中（anchor-key 回退）')
assert.deepEqual(scrolled[0], { behavior: 'smooth', block: 'center' }, 'scrollIntoView(smooth,center)')
// DSH ≥ v0.2：行带 data-chat-node-key（原始 node key）→ 优先命中
const nodeKeyOnly = makeNode(43, 'user:nodeonly')
domRows['[data-chat-node-key="user:nodeonly"]'] = makeRow()
assert.equal(T.scrollToNode(nodeKeyOnly), true, 'data-chat-node-key 优先命中')
ok('定位纯逻辑', 'findNodeBySeq / minAnchorSeq / scrollToNode')

// ── locateFromSession：直接命中 / 翻页 / 错误路径 ─────────────────────
scrolled.length = 0
directSession.getSnapshot = () => makeSnapshot([makeNode(1, 'user:one'), makeNode(5, 'user:five')])
domRows['[data-chat-anchor-key="user:five"]'] = makeRow()
assert.equal(await T.locateFromSession(directSession, 5), true, '直接命中')
assert.equal(scrolled.length, 1)
const pagedHit = makePagedSession([[makeNode(100)], [makeNode(60)], [makeNode(42)]])
domRows['[data-chat-anchor-key="node-42"]'] = makeRow()
assert.equal(await T.locateFromSession(pagedHit, 42), true, '翻页命中')
assert.equal(pagedHit.calls.loadOlder, 2, 'loadOlder 2 次')
const exhausted = makePagedSession([[makeNode(100)]])
assert.equal(await T.locateFromSession(exhausted, 42), false, '到底 false')
ok('locateFromSession', '直接命中 / 翻页命中 / 到底 false')

// ── Phase 3 修复（DSH ≥ v0.1.2）：chatSessionOf 双 DSH 取数适配 ─────
// SessionSnapshot 已不含 conversation 数据；新通道经 ctx.get('uiConversation')
// 的 binding(id).target('chat')，旧版回退 binding().session.getSnapshot()。
assert.equal(typeof T.chatSessionOf, 'function', '应导出 chatSessionOf 适配器')
let modernReads = 0
const modernCtx = {
  sessions: { binding: (id) => (id === 's2' ? { session: directSession } : undefined) },
  get: (name) => {
    if (name !== 'uiConversation') return undefined
    return {
      binding: (id) => (id === 's2' ? {
        target: (view) => (view === 'chat' ? {
          getSnapshot: () => {
            modernReads += 1
            return { order: ['user:five'], nodes: { values: () => [makeNode(5, 'user:five')] } }
          },
        } : undefined),
      } : undefined),
    }
  },
}
const modernChat = T.chatSessionOf(modernCtx, 's2')
assert.ok(modernChat, '新通道应返回会话适配器')
const modernSnap = modernChat.getSnapshot()
assert.ok(modernSnap && modernSnap.chat, '新通道快照归一化为 { chat: ChatSnapshot }')
assert.equal(T.findNodeBySeq(modernSnap, 5).key, 'user:five', '新通道 chat 节点可定位')
assert.equal(modernReads, 1, '新通道读取 uiConversation.target(chat) 视图快照')
const modernBefore = scrolled.length
assert.equal(await T.locateFromSession(modernChat, 5), true, '新通道适配器完整定位（含 loadOlder 委托）')
assert.ok(scrolled.length > modernBefore, '新通道定位触发滚动')
// 旧版回退：无 uiConversation → 用 binding().session.getSnapshot() 原样（兼容旧 DSH）
const legacyCtx = { sessions: { binding: (id) => (id === 's2' ? { session: directSession } : undefined) } }
const legacyChat = T.chatSessionOf(legacyCtx, 's2')
assert.ok(legacyChat, '旧版回退应返回适配器')
const legacySnap = legacyChat.getSnapshot()
assert.ok(legacySnap && legacySnap.chat && legacySnap.chat.nodes && typeof legacySnap.chat.nodes.values === 'function', '旧版 getSnapshot 原样委托 session（含 chat 节点）')
assert.equal(T.findNodeBySeq(legacySnap, 5).key, 'user:five', '旧版快照 chat 节点可定位')
const legacyBefore = scrolled.length
assert.equal(await T.locateFromSession(legacyChat, 5), true, '旧版适配器可定位')
assert.ok(scrolled.length > legacyBefore, '旧版定位触发滚动')
// 双通道皆无 → null（不崩溃）
assert.equal(T.chatSessionOf({ sessions: { binding: () => undefined } }, 'ghost'), null, '无会话/无新通道 → null')
ok('chatSessionOf 双 DSH', '≥v0.1.2 走 uiConversation.binding().target(chat)；旧版回退 session.getSnapshot()')

// ══ Phase 4.1：切换后索引按 current 刷新 + 子 Branch 继续显示 ══
const fetchCalls = []
let renameResponse = { ok: true, status: 200, json: async () => ({ ok: true, title: '新名称', seq: 42 }) }
globalThis.fetch = (url, init) => {
  const method = (init && init.method) || 'GET'
  fetchCalls.push({ url: String(url), method, body: init ? init.body : undefined })
  if (method === 'POST') return Promise.resolve(renameResponse)
  if (String(url).indexOf('/better-interface/session-location') !== -1) {
    const id = new URL(String(url), 'http://x').searchParams.get('sessionId')
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ sessionId: id, path: 'C:\\sessions\\session-' + id + '\\session.jsonl.zstd', folder: 'C:\\sessions\\' + id + '-folder', kind: 'jsonl', live: true }),
    })
  }
  return Promise.resolve({
    ok: true,
    status: 200,
    json: async () => ({ branchAvailable: true, messages: branchAView }),
  })
}
const branchAView = [
  { seq: 1, text: '继承的第一条', branches: [] },
  { seq: 2, text: '分支内的新消息', branches: [{ sessionId: 'branch-a-1', parentSessionId: 'branch-a', text: '从分支再分叉', seedLength: 3 }] },
]
const listBranchA = { ids: ['s2', 'branch-a'], byId: {}, current: 'branch-a' }
ReactStub.__reset()
seed[0] = true   // hover（数据层走真实 load() 流程）
renderRail({ useSessions: (sel) => sel(listBranchA) })
const currentEffect = ReactStub._effects.find((e) => Array.isArray(e.deps))
assert.ok(currentEffect, 'useEffect([current]) 应注册')
assert.equal(currentEffect.deps[0], 'branch-a', 'current 变化 → effect 依赖为切换后的 session id')
currentEffect.cb()   // 触发 load()：按切换后的 current 发请求
assert.equal(fetchCalls.at(-1).url, '/better-interface/session?sessionId=branch-a', '索引请求使用切换后的 current')
assert.equal(fetchCalls.at(-1).method, 'GET')
await new Promise((resolve) => setTimeout(resolve, 30))   // fetch → setData(ready) 落盘
const popSwitched = renderRail({ useSessions: (sel) => sel(listBranchA) })
const switchedItems = popSwitched.children[1].children.slice(1)
assert.equal(switchedItems.length, 2, '切换后索引渲染新会话的消息')
const swToggle = switchedItems[1].children[1]
assert.ok(swToggle.props.className.indexOf('sbi-branch-toggle-on') !== -1, '子 Branch 存在 → ●')
swToggle.props.onClick({ stopPropagation: () => {} })
const popSwitched2 = renderRail({ useSessions: (sel) => sel(listBranchA) })
const swChildren = popSwitched2.children[1].children
const swBranchList = swChildren.find((c) => c && c.props && c.props.className === 'sbi-branch-list')
assert.ok(swBranchList, '子 Branch 可展开')
assert.equal(swBranchList.children[0].children[1].children[0], '从分支再分叉', '二级 Branch 文本渲染')
ok('切换后刷新 + 子 Branch', 'current 变化 → 索引按新 session 加载；子 Branch 正常展开显示')

// ══ Phase 5：Branch 名称显示 + 行内重命名 ══
const nameMessages = [
  { seq: 1, text: '第一条', branches: [{ sessionId: 'branch-a', parentSessionId: 's2', text: '使用 seed 创建分支', seedLength: 2 }] },
]
function renderWithBranch(extraSeed) {
  ReactStub.__reset()
  seed[0] = true
  seed[2] = { status: 'ready', messages: nameMessages, error: null }
  if (extraSeed) Object.assign(seed, extraSeed)
  const root = renderRail({ useSessions: (sel) => sel(withSessionList) })
  // 展开 branch 列表
  const toggle = root.children[1].children[1].children[1]
  toggle.props.onClick({ stopPropagation: () => {} })
  return renderRail({ useSessions: (sel) => sel(withSessionList) })
}
function findBranchItem(root) {
  const list = root.children[1].children.find((c) => c && c.props && c.props.className === 'sbi-branch-list')
  return list.children[0]
}

// ── 非编辑态：✎ 按钮渲染（hover 显示）──────────────────────────────────
let stopCount5 = 0
let rnRoot = renderWithBranch()
const rnItem = findBranchItem(rnRoot)
assert.equal(rnItem.props.className, 'sbi-branch-item')
assert.equal(rnItem.children[0].props.className, 'sbi-branch-mark')
assert.equal(rnItem.children[1].props.className, 'sbi-branch-text')
assert.equal(rnItem.children[1].children[0], '使用 seed 创建分支', 'Branch 显示名称')
const renameBtn = rnItem.children[2]
assert.equal(renameBtn.props.className, 'sbi-branch-rename', '非编辑态应渲染 ✎ 重命名按钮')
assert.equal(renameBtn.children[0], '✎')
ok('Branch 显示 + ✎ 按钮', '非编辑态显示名称 + hover 重命名按钮')

// ── 点击 ✎ → 进入行内编辑态（input + ✓ + ✕），且不触发切换 ────────────
openedSessions.length = 0
renameBtn.props.onClick({ stopPropagation: () => { stopCount5 += 1 } })
assert.equal(stopCount5, 1, '✎ 点击应 stopPropagation')
const rnEdit = renderWithBranch({ 6: 'branch-a' })   // renamingSeq='branch-a'（seed[6]）
const editItem = findBranchItem(rnEdit)
const editBox = editItem.children[1]
assert.equal(editBox.props.className, 'sbi-branch-edit', '编辑态出现行内编辑容器')
const input = editBox.children[0]
const saveBtn = editBox.children[1]
const cancelBtn = editBox.children[2]
assert.equal(input.props.className, 'sbi-branch-input')
assert.equal(saveBtn.props.className, 'sbi-branch-save')
assert.equal(saveBtn.children[0], '✓')
assert.equal(cancelBtn.props.className, 'sbi-branch-cancel')
assert.equal(cancelBtn.children[0], '✕')
assert.equal(openedSessions.length, 0, '进入编辑态不应切换 Session')
// 编辑态点击行不触发切换
editItem.props.onClick({ stopPropagation: () => {} })
assert.equal(openedSessions.length, 0, '编辑态点击行不触发切换')
ok('行内编辑态', '✎ → input + ✓/✕，stopPropagation，不触发切换')

// ── 输入新名称 + 保存 → POST rename + 成功退出编辑态 + 刷新索引 ────────
ReactStub.__reset()
seed[0] = true
seed[2] = { status: 'ready', messages: nameMessages, error: null }
seed[6] = 'branch-a'    // 编辑态（renamingSeq）
seed[7] = '新名称'       // 输入值（ReactStub 无自动重渲染，直接预设渲染闭包值）
const rnPre = renderRail({ useSessions: (sel) => sel(withSessionList) })
const preToggle = rnPre.children[1].children[1].children[1]
preToggle.props.onClick({ stopPropagation: () => {} })   // 展开 branch-list
const rnEdit2 = renderRail({ useSessions: (sel) => sel(withSessionList) })
const editItem2 = findBranchItem(rnEdit2)
assert.ok(editItem2.children[1].props.className === 'sbi-branch-edit', '编辑态就绪')
const saveBtn2 = editItem2.children[1].children[1]
let stopSave = 0
const postIndex = fetchCalls.length   // 记录保存前的位置（POST 后 load() 会发 GET）
saveBtn2.props.onClick({ stopPropagation: () => { stopSave += 1 } })
assert.equal(stopSave, 1, '保存应 stopPropagation')
const postCall = fetchCalls[postIndex]
assert.equal(postCall.url, '/better-interface/rename', '保存应 POST /better-interface/rename')
assert.equal(postCall.method, 'POST')
assert.deepEqual(JSON.parse(postCall.body), { sessionId: 'branch-a', title: '新名称' }, 'POST body = { sessionId, title }')
await new Promise((resolve) => setTimeout(resolve, 30))   // fetch → setData(ready) 落盘
const rnSaved = renderRail({ useSessions: (sel) => sel(withSessionList) })   // renamingSeq 已复位 → 非编辑态
// load() 刷新后 stub 返回固定数据（branch-list 内容可能变化）——用整树断言编辑态已退出
assert.equal(treeHasClass(rnSaved, 'sbi-branch-edit'), false, '保存成功 → 退出编辑态')
const refreshCall = fetchCalls.filter((c) => c.method === 'GET' && c.url.indexOf('/better-interface/session') !== -1)
assert.ok(refreshCall.length >= 1, '成功后应重新请求索引（load() 刷新）')
ok('保存成功', 'POST rename → 退出编辑态 + load() 刷新索引（新名称链路由 host-test 覆盖）')

// ── 保存失败 → 行内轻量错误提示，编辑态保持 ────────────────────────────
renameResponse = { ok: false, status: 400, json: async () => ({ code: 'SESSION_NOT_LIVE', error: '请先打开该 Branch 后再重命名' }) }
ReactStub.__reset()
seed[0] = true
seed[2] = { status: 'ready', messages: nameMessages, error: null }
seed[6] = 'branch-a'   // 直接进入编辑态
seed[7] = 'xxx'
const rnFailRoot = renderRail({ useSessions: (sel) => sel(withSessionList) })
const failToggle = rnFailRoot.children[1].children[1].children[1]
failToggle.props.onClick({ stopPropagation: () => {} })
const rnFail = renderRail({ useSessions: (sel) => sel(withSessionList) })
const failItem = findBranchItem(rnFail)
failItem.children[1].children[1].props.onClick({ stopPropagation: () => {} })   // ✓ 保存
await new Promise((resolve) => setTimeout(resolve, 30))
const rnFail2 = renderRail({ useSessions: (sel) => sel(withSessionList) })
const failItem2 = findBranchItem(rnFail2)
assert.ok(failItem2.children[1].props.className.indexOf('sbi-branch-edit') !== -1, '失败后仍处于编辑态')
const errDiv = failItem2.children[1].children[3]
assert.ok(errDiv && errDiv.props.className === 'sbi-branch-error', '失败显示轻量错误')
assert.equal(errDiv.children[0], '请先打开该 Branch 后再重命名', '错误文案来自端点')
ok('保存失败', '行内错误提示，编辑态保持')

// ── 取消 → 退出编辑态，不发请求 ───────────────────────────────────────
renameResponse = { ok: true, status: 200, json: async () => ({ ok: true, title: 'x', seq: 43 }) }
const beforeCancelPosts = fetchCalls.filter((c) => c.method === 'POST').length
ReactStub.__reset()
seed[0] = true
seed[2] = { status: 'ready', messages: nameMessages, error: null }
seed[6] = 'branch-a'
const rnCancelRoot = renderRail({ useSessions: (sel) => sel(withSessionList) })
const cancelToggle = rnCancelRoot.children[1].children[1].children[1]
cancelToggle.props.onClick({ stopPropagation: () => {} })
const rnCancel = renderRail({ useSessions: (sel) => sel(withSessionList) })
const cancelItem = findBranchItem(rnCancel)
let stopCancel = 0
cancelItem.children[1].children[2].props.onClick({ stopPropagation: () => { stopCancel += 1 } })   // ✕
assert.equal(stopCancel, 1, '取消应 stopPropagation')
const rnCancel2 = renderRail({ useSessions: (sel) => sel(withSessionList) })
const cancelItem2 = findBranchItem(rnCancel2)
assert.ok(cancelItem2.children[1].props.className.indexOf('sbi-branch-edit') === -1, '取消 → 退出编辑态')
assert.equal(fetchCalls.filter((c) => c.method === 'POST').length, beforeCancelPosts, '取消不发 POST')
ok('取消重命名', '✕ → 退出编辑态，不发请求')

// ── 空标题本地拦截：不发请求，提示名称不能为空 ──────────────────────────
ReactStub.__reset()
seed[0] = true
seed[2] = { status: 'ready', messages: nameMessages, error: null }
seed[6] = 'branch-a'
seed[7] = '   '
const rnEmptyRoot = renderRail({ useSessions: (sel) => sel(withSessionList) })
const emptyToggle = rnEmptyRoot.children[1].children[1].children[1]
emptyToggle.props.onClick({ stopPropagation: () => {} })
const rnEmpty = renderRail({ useSessions: (sel) => sel(withSessionList) })
const emptyItem = findBranchItem(rnEmpty)
const postsBefore = fetchCalls.filter((c) => c.method === 'POST').length
emptyItem.children[1].children[1].props.onClick({ stopPropagation: () => {} })   // ✓
const rnEmpty2 = renderRail({ useSessions: (sel) => sel(withSessionList) })
const emptyItem2 = findBranchItem(rnEmpty2)
assert.equal(fetchCalls.filter((c) => c.method === 'POST').length, postsBefore, '空标题不发 POST')
const emptyErr = emptyItem2.children[1].children[3]
assert.ok(emptyErr && emptyErr.children[0] === '名称不能为空', '空标题本地提示')
ok('空标题拦截', '本地校验，不发请求')

// ── 点击条目本体 → 仍触发 Phase 3 跳转（不回归）───────────────────────
ReactStub.__reset()
seed[0] = true
seed[2] = { status: 'ready', messages: readyMessages, error: null }
scrolled.length = 0
domRows['[data-chat-anchor-key="node-1"]'] = makeRow()
directSession.getSnapshot = () => makeSnapshot([makeNode(1, 'node-1'), makeNode(5)])
const popClick = renderRail({ useSessions: (sel) => sel(withSessionList) })
const clickItem = popClick.children[1].children[1]   // 第一条条目（seq 1）
clickItem.props.onClick()
await new Promise((resolve) => setTimeout(resolve, 50))
assert.equal(scrolled.length, 1, '点击条目本体应触发 scrollIntoView')
ok('Phase 3 不回归', '点击消息本体仍跳转；展开按钮独立')

// ══ Phase 5.1：编辑态锁定悬浮窗 + 打开定位最新消息 ══
// ── 编辑态 mouseleave 不关闭（IME 候选窗 / 鼠标离开窗口）──────────────
ReactStub.__reset()
seed[0] = true
seed[2] = { status: 'ready', messages: nameMessages, error: null }
seed[6] = 'branch-a'   // 编辑态
const lockRoot = renderRail({ useSessions: (sel) => sel(withSessionList) })
lockRoot.children[1].props.onMouseLeave()   // armClose → 编辑态锁定
const lockRoot2 = renderRail({ useSessions: (sel) => sel(withSessionList) })
assert.ok(lockRoot2.props.className.indexOf('sbi-hover') !== -1, '编辑态 mouseleave 不关闭悬浮窗')
await new Promise((resolve) => setTimeout(resolve, 260))   // 超过 HOVER_GRACE_MS
const lockRoot3 = renderRail({ useSessions: (sel) => sel(withSessionList) })
assert.ok(lockRoot3.props.className.indexOf('sbi-hover') !== -1, '编辑态下延迟后仍保持打开')
ok('编辑态锁定', '改名期间（IME/鼠标离开）悬浮窗不关闭')

// ── 非编辑态 mouseleave → 正常关闭（回归）────────────────────────────
ReactStub.__reset()
seed[0] = true
seed[2] = { status: 'ready', messages: nameMessages, error: null }
const closeRoot = renderRail({ useSessions: (sel) => sel(withSessionList) })
closeRoot.children[1].props.onMouseLeave()
await new Promise((resolve) => setTimeout(resolve, 260))
const closeRoot2 = renderRail({ useSessions: (sel) => sel(withSessionList) })
assert.equal(closeRoot2.props.className, 'sbi-root', '非编辑态 mouseleave 后正常关闭')
ok('非编辑态关闭回归', '普通悬停离开仍按 220ms 关闭')

// ── 打开时滚动到底部（最新消息）─────────────────────────────────────
ReactStub.__reset()
seed[0] = true
seed[2] = { status: 'ready', messages: nameMessages, error: null }
const scrollRoot = renderRail({ useSessions: (sel) => sel(withSessionList) })
const popRefObj = seed[9]   // popRef（useRef）
assert.ok(popRefObj && popRefObj.current, 'popup 应绑定 ref')
popRefObj.current.scrollTop = 0
popRefObj.current.scrollHeight = 300
scrollRoot.children[0].props.onMouseEnter()   // openPop（firstOpen=true）→ scrollToBottom
assert.equal(popRefObj.current.scrollTop, 300, '打开时滚动到底部（最新消息）')
// 同一 hover 会话内 rail↔pop 移动不重复跳底（firstOpen=false）
popRefObj.current.scrollTop = 0
popRefObj.current.scrollHeight = 300
scrollRoot.children[1].props.onMouseEnter()   // 再次 openPop（hoverRef 已 true）
assert.equal(popRefObj.current.scrollTop, 0, '同一会话内再次进入不强制跳底')
ok('打开定位最新', '每次重新打开滚到最新消息；会话内移动不打扰')

// ══ Phase 6：打开所在文件夹（📂）══
const openedFolders = []
ctxStub.workspaces = { openPath: (p) => { openedFolders.push(p); return Promise.resolve() } }

// ── inject 含 workspaces ────────────────────────────────────────────
assert.ok(exportsObj.inject.includes('workspaces'), 'inject 应含 workspaces（侧栏隐藏 + 旧版兜底）')
ok('inject workspaces', 'client inject = [slots, sessions, workspaces]（remote/remote.session 用 ctx.get 懒解析，不进静态 inject）')

// ── Branch 项 📂 → fetch session-location → 打开文件夹 ──────────────
// （本段 ctxStub 无 ctx.get → 走 openFolderNative 的旧版 workspaces.openPath 兜底）
ReactStub.__reset()
seed[0] = true
seed[2] = { status: 'ready', messages: nameMessages, error: null }
const folderRoot = renderRail({ useSessions: (sel) => sel(withSessionList) })
const folderToggle = folderRoot.children[1].children[1].children[1]
folderToggle.props.onClick({ stopPropagation: () => {} })   // 展开 branch-list
const folderExpanded = renderRail({ useSessions: (sel) => sel(withSessionList) })
const folderItem = findBranchItem(folderExpanded)
const folderBtn = folderItem.children[3]
assert.equal(folderBtn.props.className, 'sbi-branch-folder', '非编辑态应渲染 📂 按钮')
assert.equal(folderBtn.children[0], '📂')
let stopFolder = 0
folderBtn.props.onClick({ stopPropagation: () => { stopFolder += 1 } })
assert.equal(stopFolder, 1, '📂 点击应 stopPropagation')
const locCall = fetchCalls.at(-1)
assert.equal(locCall.url, '/better-interface/session-location?sessionId=branch-a', '应请求 session-location')
await new Promise((resolve) => setTimeout(resolve, 30))   // fetch → 打开落盘
assert.deepEqual(openedFolders, ['C:\\sessions\\branch-a-folder'], '旧版兜底应调用 workspaces.openPath(folder)')
ok('Branch 📂（旧版兜底）', '📂 → GET session-location → workspaces.openPath(folder)（不触发切换）')

// ── pop-head 📂 → 当前会话文件夹（旧版兜底）────────────────────────
openedFolders.length = 0
ReactStub.__reset()
seed[0] = true
seed[2] = { status: 'ready', messages: nameMessages, error: null }
const headRoot = renderRail({ useSessions: (sel) => sel(withSessionList) })
const headBtn = headRoot.children[1].children[0].children[1]
assert.equal(headBtn.props.className, 'sbi-head-folder', 'pop-head 应渲染 📂 按钮')
headBtn.props.onClick({ stopPropagation: () => {} })
const headLoc = fetchCalls.at(-1)
assert.equal(headLoc.url, '/better-interface/session-location?sessionId=s2', '当前会话 → session-location')
await new Promise((resolve) => setTimeout(resolve, 30))
assert.deepEqual(openedFolders, ['C:\\sessions\\s2-folder'], '旧版兜底 openPath(当前会话 folder)')
ok('当前会话 📂（旧版兜底）', 'pop-head 📂 → workspaces.openPath(当前会话 folder)')

// ── Phase 6 修复（DSH ≥ v0.1.2）：官方 ctx.remote.session 通道优先 ──
// ctx.get 是 cordis 安全读取（不要求 inject）。注入 ctx.get('remote.session')
// 模拟新 DSH 形态，断言新通道被优先使用、旧通道不再触发。
const openedRemote = []
let remoteSession = {
  canOpenWorkspacePath: () => Promise.resolve({ ok: true, value: true }),
  openWorkspacePath: (req) => { openedRemote.push(req); return Promise.resolve({ ok: true, value: { opened: true } }) },
}
ctxStub.get = (name) => {
  if (name === 'remote.session') return remoteSession
  if (name === 'remote') return { session: remoteSession }
  return undefined
}
openedFolders.length = 0
openedRemote.length = 0
ReactStub.__reset()
seed[0] = true
seed[2] = { status: 'ready', messages: nameMessages, error: null }
const modernRoot = renderRail({ useSessions: (sel) => sel(withSessionList) })
const modernHeadBtn = modernRoot.children[1].children[0].children[1]
modernHeadBtn.props.onClick({ stopPropagation: () => {} })
await new Promise((resolve) => setTimeout(resolve, 30))
assert.deepEqual(openedRemote, [{ path: 'C:\\sessions\\s2-folder' }], '新通道应调用 openWorkspacePath({ path })')
assert.equal(openedFolders.length, 0, '新通道存在时不走旧 workspaces.openPath')
ok('📂 新通道优先', 'ctx.get(remote.session) → canOpenWorkspacePath → openWorkspacePath({path})')

// ── 能力探测 false → 不发起 open（只报错）─────────────────────────
openedRemote.length = 0
openedFolders.length = 0
remoteSession.canOpenWorkspacePath = () => Promise.resolve({ ok: true, value: false })
const capRoot = renderRail({ useSessions: (sel) => sel(withSessionList) })
capRoot.children[1].children[0].children[1].props.onClick({ stopPropagation: () => {} })
await new Promise((resolve) => setTimeout(resolve, 30))
assert.equal(openedRemote.length, 0, 'canOpenWorkspacePath=false → 不调用 openWorkspacePath')
ok('📂 能力探测', 'canOpenWorkspacePath=false → 拒绝打开（console 报错，不崩溃）')

// ── host 打开失败（信封 error）→ console 报错、不崩溃 ──────────────
remoteSession.canOpenWorkspacePath = () => Promise.resolve({ ok: true, value: true })
remoteSession.openWorkspacePath = () => Promise.resolve({ ok: false, error: { code: 'internal', message: 'path open failed: boom' } })
const hostErr = []
const origErr = console.error
console.error = (...a) => { hostErr.push(a.map(String).join(' ')) }
try {
  const hostFailRoot = renderRail({ useSessions: (sel) => sel(withSessionList) })
  hostFailRoot.children[1].children[0].children[1].props.onClick({ stopPropagation: () => {} })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.ok(hostErr.some((m) => m.indexOf('打开文件夹失败') !== -1 && m.indexOf('boom') !== -1), 'host 拒绝 → console 报错带原因')
} finally { console.error = origErr }
ok('📂 host 拒绝', 'openWorkspacePath 信封错误 → console 报错（不崩溃）')

// ── 双通道均缺失（新版无 workspaces.openPath 且无 remote.session）──
delete ctxStub.get
delete ctxStub.workspaces
openedRemote.length = 0
openedFolders.length = 0
const noneErr = []
console.error = (...a) => { noneErr.push(a.map(String).join(' ')) }
try {
  const noneRoot = renderRail({ useSessions: (sel) => sel(withSessionList) })
  noneRoot.children[1].children[0].children[1].props.onClick({ stopPropagation: () => {} })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(openedRemote.length + openedFolders.length, 0, '通道缺失 → 不打开任何文件夹')
  assert.ok(noneErr.some((m) => m.indexOf('打开文件夹失败') !== -1), '通道缺失 → console 报错')
} finally { console.error = origErr }
ok('📂 通道缺失降级', '无 remote.session / workspaces.openPath → console 报错，不崩溃')

// ── 失败路径：端点 404 → 不打开任何文件夹 ─────────────────────────
openedFolders.length = 0
globalThis.fetch = (url, init) => {
  fetchCalls.push({ url: String(url), method: (init && init.method) || 'GET' })
  return Promise.resolve({ ok: false, status: 404, json: async () => ({ code: 'SESSION_NOT_FOUND', error: 'not found' }) })
}
ReactStub.__reset()
seed[0] = true
seed[2] = { status: 'ready', messages: nameMessages, error: null }
const failRoot = renderRail({ useSessions: (sel) => sel(withSessionList) })
const failHeadBtn = failRoot.children[1].children[0].children[1]
failHeadBtn.props.onClick({ stopPropagation: () => {} })
await new Promise((resolve) => setTimeout(resolve, 30))
assert.equal(openedFolders.length, 0, '端点失败不打开文件夹')
ok('📂 失败路径', '端点错误 → Console 报错，不打开')

// ══ Phase 6：设置面板管理界面（settings.section）══
// ── 注册：仅 BetterInterface（order 21，Agent 预设下方）────────────────
const sectionRegs = regCalls.filter((r) => r.registered && r.registered.name === 'settings.section')
assert.equal(sectionRegs.length, 1, '应注册 1 个 settings.section')
const secBI = sectionRegs[0]
assert.equal(secBI.registered.id, 'better-interface', '条目 id 为 better-interface')
assert.equal(secBI.registered.order, 21, 'order 21（Agent 预设下方）')
assert.equal(secBI.registered.label(), 'BetterInterface')
ok('settings.section 注册', '仅 BetterInterface(order 21) 一个插件条目')

// ── 管理组件渲染：列表 + 状态徽标 + 操作按钮 ───────────────────────────
// 恢复完整 fetch（含 manage / session-state / session-location 分支）
const manageRows = [
  { sessionId: 'branch-a', state: 'active', live: true },
  { sessionId: 'branch-cold', state: 'hidden', live: false },
  { sessionId: 'native-1', state: 'archived', live: false, nativeArchived: true },
]
globalThis.fetch = (url, init) => {
  fetchCalls.push({ url: String(url), method: (init && init.method) || 'GET', body: init ? init.body : undefined })
  const u = String(url)
  if (u.indexOf('/better-interface/manage-sessions') !== -1) {
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ sessions: manageRows, states: ['active', 'hidden', 'archived'] }) })
  }
  if (u.indexOf('/better-interface/session-state') !== -1) {
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, sessionId: 'branch-a', state: 'hidden' }) })
  }
  if (u.indexOf('/better-interface/session-location') !== -1) {
    const id = new URL(u, 'http://x').searchParams.get('sessionId')
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ folder: 'C:\\sessions\\' + id, path: 'C:\\sessions\\session-' + id, kind: 'jsonl', live: true }) })
  }
  return Promise.resolve({ ok: true, status: 200, json: async () => ({ branchAvailable: true, messages: [] }) })
}
function renderSection(reg, props) { ReactStub._hookIndex = 0; return reg.component(props) }
ReactStub.__reset()
// settings.section 标准 props：useSessions（displayTitle）+ useWorkspaces（归属）
const sessionFeed = {
  ids: ['branch-a', 'branch-cold', 'native-1'],
  byId: {
    'branch-a': { displayTitle: '使用 seed 创建分支' },
    'branch-cold': { displayTitle: '换一种架构实现' },
    'native-1': { displayTitle: '原生归档对话' },
  },
  current: undefined,
}
const workspaceFeed = { items: [{ workspaceId: 'w1', title: 'DSH', sessionIds: ['branch-a'] }], archivedSessionIds: [] }
const secProps = {
  close: () => {},
  ...secBI.registered.inject(),
  useSessions: (sel) => sel(sessionFeed),
  useWorkspaces: (sel) => sel(workspaceFeed),
}
let mgRoot = renderSection(secBI, secProps)
assert.equal(mgRoot.props.className, 'sbi-manage-root', '管理界面根元素')
assert.equal(treeHasClass(mgRoot, 'sbi-manage-title'), true, '标题 BetterInterface')
// 触发 loadManage（useEffect deps=[]）
const mgEffect = ReactStub._effects.find((e) => Array.isArray(e.deps) && e.deps.length === 0)
assert.ok(mgEffect, '管理界面应注册 useEffect([]) 加载列表')
mgEffect.cb()
await new Promise((resolve) => setTimeout(resolve, 30))
mgRoot = renderSection(secBI, secProps)
const mgList = mgRoot.children[0].children[3]
assert.ok(mgList && mgList.props.className === 'sbi-manage-list', '会话列表容器')
// 递归收集所有会话行（分组结构：group → group-body → rows）
function allRowsInList(listEl) {
  const out = []
  // 正序队列（BFS）：保持文档顺序（DSH 组在前、未分组在后）。
  const queue = [...(listEl.children || [])]
  let qi = 0
  while (qi < queue.length) {
    const node = queue[qi++]
    if (node === null || node === undefined || typeof node === 'string') continue
    if (node.props && node.props.className === 'sbi-manage-row') { out.push(node); continue }
    if (Array.isArray(node.children)) {
      for (const c of node.children) queue.push(c)
    }
  }
  return out
}
// 分组：DSH（branch-a）+ 未分组（branch-cold、native-1）
const mgGroups = mgList.children.filter((c) => c && c.props && c.props.className === 'sbi-manage-group')
assert.equal(mgGroups.length, 2, '按工作区分组：DSH + 未分组')
const gDsh = mgGroups[0]
const gDshHead = gDsh.children[0]
assert.ok(gDshHead.props.className.indexOf('sbi-manage-group-head') !== -1, '分组头')
assert.equal(gDshHead.children[1].children[0], 'DSH', '分组标题 = 工作区名')
assert.equal(gDshHead.children[2].children[0], 1, 'DSH 组会话数 1')
const gUngrouped = mgGroups[1]
assert.equal(gUngrouped.children[0].children[1].children[0], '未分组', '未归属会话进未分组')
const mgRows = allRowsInList(mgList)
assert.equal(mgRows.length, 3, '渲染 3 个会话行（分组内）')
const row1 = mgRows[0]
assert.ok(row1.children[0].props.className.indexOf('sbi-manage-state-active') !== -1, 'active 徽标')
const acts1 = row1.children[2].children
assert.equal(acts1[0].children[0], '隐藏')
assert.equal(acts1[1].children[0], '归档')
assert.equal(acts1[2].children[0], '📂')
assert.equal(acts1.length, 3, '活跃会话不展示删除按钮')
// 名称与工作区显示（displayTitle + workspace.title）
const name1 = row1.children[1].children[0]
assert.equal(name1.props.className, 'sbi-manage-name')
assert.equal(name1.children[0], '使用 seed 创建分支', '显示会话名称（displayTitle）')
const meta1 = row1.children[1].children[1]
assert.equal(meta1.props.className, 'sbi-manage-meta')
assert.ok(meta1.children[0].indexOf('branch-a') !== -1, 'meta 含 sessionId')
assert.ok(meta1.children[0].indexOf('DSH') !== -1, 'meta 含所属工作区 title')
const row2 = mgRows[1]
assert.ok(row2.children[0].props.className.indexOf('sbi-manage-state-hidden') !== -1, 'hidden 徽标')
assert.equal(row2.children[2].children[0].children[0], '恢复')
const name2 = row2.children[1].children[0]
assert.equal(name2.children[0], '换一种架构实现', 'cold 会话也显示名称')
// 原生归档行可打开文件夹或删除已关闭的会话。
const row3 = mgRows[2]
assert.equal(row3.children[0].children[0], '已归档（原生）', '原生归档徽标')
assert.equal(row3.children[2].children.length, 2, '原生归档可删除')
assert.equal(row3.children[2].children[0].children[0], '📂')
ok('管理界面渲染', '分工作组 + 名称/工作区 + 状态徽标 + 隐藏/归档/恢复/📂 + 原生归档')

// ── 管理界面 📂（用户反馈的设置页入口）→ 官方 remote.session 通道 ────
// 设置面板注入的 openPath = openFolderNative(ctx)，走与悬浮窗相同的通道。
const manageRemote = {
  canOpenWorkspacePath: () => Promise.resolve({ ok: true, value: true }),
  openWorkspacePath: (req) => { openedRemote.push(req); return Promise.resolve({ ok: true, value: { opened: true } }) },
}
ctxStub.get = (name) => {
  if (name === 'remote.session') return manageRemote
  if (name === 'remote') return { session: manageRemote }
  return undefined
}
openedRemote.length = 0
const mgFolderBtn = mgRows[0].children[2].children[2]   // active 行第三个操作 = 📂
assert.equal(mgFolderBtn.children[0], '📂')
mgFolderBtn.props.onClick()
await new Promise((resolve) => setTimeout(resolve, 30))
assert.deepEqual(openedRemote, [{ path: 'C:\\sessions\\branch-a' }], '设置管理页 📂 → openWorkspacePath(folder)')
delete ctxStub.get
ok('管理界面 📂（新通道）', '设置页会话行 📂 → remote.session.openWorkspacePath({ path: folder })')

// ── 折叠：点击 DSH 分组头 → 组体消失 ─────────────────────────────────
gDshHead.props.onClick()
mgRoot = renderSection(secBI, secProps)
const gDsh2 = mgRoot.children[0].children[3].children.filter((c) => c && c.props && c.props.className === 'sbi-manage-group')[0]
// 折叠后 body 为 null（React 忽略 null 不渲染）；过滤 null 后只剩分组头。
assert.equal(gDsh2.children.filter((c) => c !== null).length, 1, '折叠后组体消失（只剩分组头）')
assert.equal(gDsh2.children[1], null, '组体为 null（不渲染）')
gDsh2.children[0].props.onClick()   // 重新展开
mgRoot = renderSection(secBI, secProps)
const gDsh3 = mgRoot.children[0].children[3].children.filter((c) => c && c.props && c.props.className === 'sbi-manage-group')[0]
assert.equal(gDsh3.children.length, 2, '再次点击恢复展开')
ok('分组折叠', '分组头点击折叠/展开')

// ── 状态切换：点击"隐藏" → POST session-state → 重新加载 ──────────────
const postsBeforeManage = fetchCalls.filter((c) => c.method === 'POST').length
acts1[0].props.onClick()
const statePost = fetchCalls.at(-1)
assert.equal(statePost.url, '/better-interface/session-state', '状态切换应 POST /session-state')
assert.deepEqual(JSON.parse(statePost.body), { sessionId: 'branch-a', state: 'hidden' })
await new Promise((resolve) => setTimeout(resolve, 30))
assert.ok(fetchCalls.filter((c) => c.method === 'POST').length > postsBeforeManage, 'POST 已发出')
ok('状态切换', '点击隐藏 → POST session-state { sessionId, state }')

// ── 过滤 tabs：点击"已隐藏" → 只显示 hidden（分组结构内）──────────────
mgRoot = renderSection(secBI, secProps)
const filterBtns = mgRoot.children[0].children[2].children
filterBtns[1].props.onClick()   // "已隐藏"
mgRoot = renderSection(secBI, secProps)
const filteredRows = allRowsInList(mgRoot.children[0].children[3])
assert.equal(filteredRows.length, 1, '过滤后只剩 hidden 行')
ok('过滤 tabs', '已隐藏 → 只显示 hidden 会话')

assert.equal(filteredRows[0].children[2].children.length, 2, '已隐藏会话不展示删除按钮')
filterBtns[2].props.onClick()
mgRoot = renderSection(secBI, secProps)
const archivedRows = allRowsInList(mgRoot.children[0].children[3])
const deleteButton = archivedRows[0].children[2].children.find((action) => action.children[0] === '删除')
assert.equal(deleteButton.props.disabled, false)
const deleteCalls = []
const existingFetch = globalThis.fetch
globalThis.fetch = (url, options) => {
  if (options?.method !== 'DELETE') return existingFetch(url, options)
  deleteCalls.push(url)
  return Promise.resolve({ ok: true })
}
windowStub.confirm = () => false
await deleteButton.props.onClick()
assert.equal(deleteCalls.length, 0, '取消确认不发删除请求')
windowStub.confirm = () => true
await deleteButton.props.onClick()
assert.deepEqual(deleteCalls, ['/better-interface/session-delete?sessionId=native-1'])
ok('删除确认', '确认后才请求删除已归档且关闭的会话')

console.log('\n结果: ' + passed + ' 项断言全部通过')
