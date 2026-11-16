# dsh-better-interface

DSH Web 插件，提供会话索引、分支与会话管理、长消息折叠，以及 DeepSeek API 价格和余额面板。

[安装与升级](#安装) · [价格和余额监控](#价格和余额监控)

对话区域最右侧、垂直居中的细长圆角按钮（内部三个圆圈）。鼠标**悬停**后在按钮左侧
展开索引窗口，显示**当前打开 Session 的用户消息**（正序、纯文本摘要、前 30 字符）。
点击某条索引 → Chat 页面自动滚动到该消息；点击消息右侧 ● 展开从该位置创建的
Branch 并切换进入对应 Session。Branch 显示真实名称（title 优先），hover 后点击
✎ 可**行内重命名**（仅 Live；Cold 提示先打开）。读取只读，重命名只经 DSH 原生
SessionTitleService（append session/title、pins 标题）。

## 功能一览

| 功能 | 说明 | 阶段 |
|---|---|---|
| 右缘竖向入口 | position:fixed 右缘 8px、垂直居中、16px 宽圆角竖条、3 圆圈；**始终显示** | Phase 0 |
| 悬停索引窗口 | 按钮左侧展开（272px 宽 / 最高 62vh / 内部滚动）；移出 220ms 收起 | Phase 0 |
| 窗口常驻 DOM | hover 只切换 `.sbi-hover` 类（opacity 显隐），绝不插入/移除元素——杜绝首帧错位 | Phase 0 修复 |
| 缝隙桥接 | hover 时 rail ::after 向左延伸 14px 覆盖 rail↔窗口间隙，防边缘疯狂闪烁 | Phase 0 修复 |
| 当前会话索引 | 用户消息**正序**纯文本（前 30 字符，超长省略 + …）；不显示 seq / JSON | Phase 2.1 |
| synthetic 过滤 | 只保留真实用户输入（`source.kind === 'user'`）；插件通知 / AGENTS.md / skill / goal 续跑等注入一律排除 | Phase 2.1 修复 |
| 点击定位 | 索引项 → seq → 会话快照 anchorSeq → nodeKey → DOM 行 scrollIntoView(smooth, center)；停在「轨迹」视图时先自动切回「对话」再定位 | Phase 3 |
| 长会话翻页 | 目标不在窗口 → 循环 `session.loadOlder()` 向前翻（每页 50 条，上限 300 页）；每页间让出一帧 | Phase 3 |
| 无副作用定位 | 无高亮 / 无动画 / 无弹窗；失败只打 Console 错误 | Phase 3 |
| Branch 展开 | 消息右侧 ○（无分支，点击无效果）/ ●（有分支，点击展开）；└ 缩进列表，点击切换 Session | Phase 4 |
| 事件隔离 | 展开按钮 / Branch / ✎ / 保存 / 取消全部 stopPropagation，互不触发 | Phase 4+5 |
| Live/Cold 枚举 | `sessionPersistence.list()` + `sessions.list()` 按 id 合并、live 优先——重启后未打开的 Cold Branch 也能发现 | Phase 4.1 |
| 多级 Branch | 沿 `header.parentSession` 逐级发现（Branch 的 Branch）；Cold 只读 `persistence.inspect`，不 resume 不 open | Phase 4.1 |
| 安全降级 | persistence 缺失 / list 抛错 → `branchAvailable=false` 索引与 live 分支照常；单 child inspect 失败只跳过该 child | Phase 4.1 |
| Branch 真实名称 | session/title 的 `data.title` 优先；无 title 回退 Branch 首条新用户消息 | Phase 5 |
| 行内重命名 | hover Branch 显示 ✎ → 行内输入框 + ✓ 保存 / ✕ 取消；仅 Live（经 DSH 原生 SessionTitleService），Cold 明确拒绝 | Phase 5 |
| 编辑态锁定 | 改名期间（输入法候选窗 / 鼠标移出窗口）悬浮窗**不关闭**；取消/保存后恢复 | Phase 5.1 |
| 打开定位最新 | 每次重新打开悬浮窗滚到**最新消息**（底部）；同一悬停会话内移动与静默刷新不打扰 | Phase 5.1 |
| 打开所在文件夹 | Branch 项 / 窗口头部 / 设置页会话行 📂 → host locate() 定位会话文件 → DSH 原生打开通道（≥v0.1.2 用官方 remote.session.openWorkspacePath，旧版回退 workspaces.openPath） | Phase 6 |
| 删除会话 | 在设置页确认后，将已归档且已关闭会话的 JSONL 记录移到本地回收目录 | |
| 设置面板管理界面 | 设置弹窗导航（Agent 预设下方）新增「BetterInterface」条目 → 面板内管理页（会话列表/状态徽标/过滤 tabs/隐藏/归档/恢复/📂） | Phase 6 |
| 名称与归属显示 | 管理界面每行显示会话**名称**（displayTitle，与侧栏同源）+ **所属工作区**（workspace.title）+ sessionId | Phase 6 |
| 分工作组 | 管理界面按**工作区**分组（▾ 标题 + 会话数，可折叠）；未归属会话进「未分组」 | Phase 6 |
| 状态联动索引 | hidden/archived 的 Branch 从**悬浮窗索引**自动过滤（corpus 层过滤，当前会话不受影响）；恢复后重新出现；**DSH 原生归档（侧栏归档）也一并过滤** | Phase 6 |
| 原生归档合并 | 管理界面显示 DSH 原生归档的会话（徽标「已归档（原生）」，无恢复按钮——DSH 无 unarchive API） | Phase 6 |
| 用户长消息折叠 | Chat 用户气泡（user / steering）> 5 行自动折叠（5 行 + 渐变遮罩）；气泡左下角半透明 ▲/▼ 小三角按钮展开/收起（跟随滚动）；3 行及以下不折叠 | Phase 7 |
| 侧栏 DOM 隐藏 | hidden 会话从 DSH 左侧栏隐藏（标题精确匹配 + MutationObserver 兜底；恢复 active 自动取消隐藏）——弥补 DSH 无 unarchive 的缺口（官方 API 无法做到侧栏隐藏且可恢复） | Phase 6.6 |

## 交互形态

```text
┌──────────────────────────────────────────────┐
│                                              │
│                DSH Chat       ┌────────────┐ │
│                               │ 对话索引    │ │
│                               ├────────────┤ │
│                               │ 我们现在讨论 DSH... │
│                               └────────────┘ │
│                                      ╭───╮   │
│                                      │ ● │   │
│                                      │ ● │   │
│                                      │ ● │   │
│                                      ╰───╯   │
└──────────────────────────────────────────────┘
```

- **按钮**：position:fixed 右缘 8px、垂直居中、16px 宽竖向圆角矩形、3 个圆圈；始终显示。
- **索引窗口**：Hover 按钮后在其**左侧**展开（272px 宽、最高 62vh、内部滚动），
  移出按钮/窗口 220ms 后收起（期间移入另一方则保持）。
  - **窗口常驻 DOM**：hover 只切换 root 的 `.sbi-hover` 类（opacity 显隐），
    绝不按 hover 插入/移除元素——杜绝"从右下角闪现再归位"的首帧错位。
  - **缝隙桥接**：hover 时 rail 的 ::after 向左延伸 14px，覆盖 rail 与窗口之间
    的 12px 间隙，鼠标在二者之间移动不会触发离开（防边缘疯狂闪烁）。
  - **打开定位最新**：每次重新打开自动滚到底部（索引正序、最早在上，但用户更关注
    新消息）；首次加载与会话切换后也滚到底部；同一悬停会话内 rail↔窗口移动与
    静默刷新不打断用户滚动位置。
- **数据通道**：Client 用框架标准 useSessions 拿当前 session id → Host 端点取
  ConversationItem[]（{seq, text, branches}）→ 窗口渲染正序纯文本（**不显示 seq/JSON**）。
- **索引口径**：只保留 **真实用户输入**（`event.data.source.kind === 'user'`）；
  synthetic agent.inject() 上下文（插件运行通知、AGENTS.md、skill 内容、goal
  续跑通知等）同为 user/message 事件但 `source.kind !== 'user'`，一律排除。
- **点击定位（Phase 3）**：点击索引项 → seq → 会话快照（`snapshot.chat.nodes`
  按 `anchorSeq`）→ `node.key` → DOM 行 `[data-chat-anchor-key]` →
  `scrollIntoView({behavior:'smooth', block:'center'})`。取数经 `chatSessionOf()`
  双代适配：**DSH ≥ v0.1.2** 走 `ctx.get('uiConversation').binding(id).target('chat')`
  （官方 ui-chat 同源；SessionSnapshot 已不含 conversation 数据），旧版回退
  `ctx.sessions.binding(id).session.getSnapshot()`；两通道都归一化为
  `{ chat: <ChatSnapshot> }`，定位/翻页逻辑零改动。
  - 目标不在当前窗口（长会话历史分页，每页 50 条）→ 循环 `session.loadOlder()`
    向前翻页直到目标出现或历史到底；找不到只打 Console 错误，不崩溃。
  - **无高亮 / 无动画 / 无弹窗**（Phase 3 规格）；条目仅 cursor:pointer 提示可点。
  - 条目文本**单行省略**；鼠标移上去条目被**灰白边框包裹**（浅灰背景 + l2 边框、
    8px 圆角——与 PriceMonitor / Settings 触发器同一套 hover 效果）。
- **Branch 展开（Phase 4）**：每条索引右侧有展开按钮——有 Branch → **●**（点击展开），
  无 → **○**（点击无效果）。展开后在该消息**下方缩进**显示 Branch 列表（└ + 文本）；
  点击 Branch → ctx.sessions.open(sessionId) 原生切换 Session，索引自动刷新为
  新会话。展开按钮 stopPropagation，点击它**不会触发** Phase 3 消息跳转。
- **Branch 名称（Phase 5）**：Branch 项显示对应 Session 的真实名称——优先
  session/title 事件的 `data.title`，无 title 回退首条新用户消息（lib/session.js
  sessionTitle 已从误读 `data.text` 修正为 `data.title`）。
- **Branch 重命名（Phase 5）**：hover Branch 项显示 **✎** → 点击进入**行内编辑态**
  （输入框 + ✓ 保存 / ✕ 取消）；保存 POST /better-interface/rename → host 经
  `ctx.sessionTitle.rename()`（DSH 原生，append session/title、pins 标题、空标题拒绝）
  → 成功退出编辑态并刷新索引显示新名称；失败在行内显示轻量错误。
  - **仅 Live**：Cold Branch 返回明确错误「请先打开该 Branch 后再重命名」，
    不自动 resume（文档 §15 决策）。
  - 编辑态/✎/保存/取消全部 stopPropagation，不触发 Branch 切换与 Phase 3 跳转。
  - **编辑态锁定（Phase 5.1）**：改名期间悬浮窗**不因 mouseleave 关闭**（
    输入法候选窗 / 鼠标移出窗口都不会打断编辑）；取消或保存后才恢复正常关闭。
- **打开所在文件夹（Phase 6）**：hover Branch 项显示 **📂**（与 ✎ 并列）→ 点击
  `GET /better-interface/session-location` 取回会话文件绝对路径（host 用
  `sessionPersistence.locate()`，纯路径计算、不 materialize、不 resume）→ client
  经 `openFolderNative()` 打开资源管理器：**DSH ≥ v0.1.2 走官方
  `ctx.remote.session.canOpenWorkspacePath()/openWorkspacePath({ path })`**
  （2026-08 client refactor 已删除 `ctx.workspaces.openPath`；两通道都用 `ctx.get()`
  懒解析，不进静态 inject，旧版 DSH 自动回退 `ctx.workspaces.openPath(folder)`）。
  窗口头部（对话索引标题右侧）也有 📂，打开**当前会话**所在文件夹；设置面板
  管理页每个会话行同样带 📂。删除会话可使用设置页独立的「删除」按钮。
- **长消息折叠（Phase 7）**：Chat 中超过 5 行的用户气泡（`data-chat-flow-kind` 为
  `user` 或 `steering`——后者是 0.2 起常见的排队/插话消息，同为用户气泡样式）
  自动折叠为 5 行 + 底部
  渐变遮罩，气泡左下角显示**半透明灰色小三角**按钮——折叠态 **▲**（内容已收起）、
  展开态 **▼**（内容在下方展开）；点击切换，按钮锚定气泡左下角（inline
  position:relative 持久化）跟随滚动。3 行及以下短消息**绝不折叠**；hover 仅颜色
  微变（无灰底白框强调）。判定链路：`[data-chat-flow-kind="user"]` 定位行 →
  findBubble（非透明背景 + 圆角特征）选气泡 → 放宽预判 + 折叠自检（同帧撤销未
  实际裁剪的折叠，无闪烁）。
- 刷新：current 变化时读取一次；悬停会话**开始时**再读一次（同一悬停期间不重复），
  且**已有数据时静默刷新**（不切"加载中…"）；无定时轮询。
- 只读调查：`GET /better-interface/session?sessionId=…&debug=1` 返回事件类型/来源分布
  与样本（正常响应不带任何附加字段）。

## 架构

```
浏览器（lib/client.js）                        Host（index.js + lib/session.js）
─────────────────────                        ───────────────────────────
shell.overlay Rail（按钮 + Hover 窗口）         GET /better-interface/session
  · useSessions → 当前 session id  ──fetch──→   ctx.sessions.get(id).events
  · 渲染正序纯文本摘要                          → userMessages() 过滤 source.kind==='user'
  · 点击条目 → chatSessionOf(ctx, current)：       → {seq,text,branches}（text 截断 previewChars）
      ≥v0.1.2: ctx.get('uiConversation').binding(id)
        .target('chat').getSnapshot().chat.nodes
      旧版: binding(id).session.getSnapshot().chat.nodes
      → anchorSeq === seq → node.key
      → [data-chat-anchor-key] → scrollIntoView
      → 未命中则循环 session.loadOlder() 翻历史窗口
  · Branch（Phase 4.1）：端点以 sessionPersistence.list()（全部持久化 header）+
      sessions.list()（live）按 id 合并、live 优先 → 过滤 header.parentSession === 当前 id；
      seedLength-1 → 父 events 最后一条用户消息 → branches[] 挂载；
      Branch 文本：session/title 的 data.title 优先 / 无 title 回退首条新用户消息
      （live 直接取，cold 用 persistence.inspect() 只读，不 resume、不 open）；
      POST /better-interface/rename { sessionId, title } → ctx.sessionTitle.rename()
      （仅 Live；Cold 拒绝）；点击 Branch → ctx.sessions.open(sessionId)
  · 📂（Phase 6）：GET /better-interface/session-location?sessionId=… →
      sessionPersistence.locate(header) → { path, folder }（不 materialize）→
      client openFolderNative()：ctx.remote.session.openWorkspacePath({path})
      （≥v0.1.2 官方通道）/ ctx.workspaces.openPath(folder)（旧版兜底）打开资源管理器
  · 编辑态锁定 + 打开定位最新（Phase 5.1，纯 client 行为）
```

## HTTP 端点

webServer 路由按 pathname 匹配（无 method 字段），handler 内自行守卫方法。

### GET /better-interface/session

当前 Session 的用户消息索引 + Branch 挂载。

| 参数 | 必填 | 说明 |
|---|---|---|
| sessionId | ✅ | 目标 Session id |
| debug | — | `1` 或 `true` → 附加只读调查字段（见下） |

成功 200：

```json
{
  "sessionId": "s-1",
  "messages": [
    {
      "seq": 3,
      "text": "第一条用户消息",
      "branches": [
        { "sessionId": "b-1", "parentSessionId": "s-1", "text": "重构 FPGA DMA 架构", "seedLength": 2 }
      ]
    }
  ],
  "branchAvailable": true
}
```

- `messages`：正序（最早在上）；`text` 截断到 previewChars（默认 30）+ …；
  `branches` 为该消息锚点下挂载的直接子 Session（空数组表示无分支）。
- `branchAvailable=false`：persistence 不可用 / list 抛错（安全降级，索引照常）。
- `debug=1` 时附加 `debug: { eventTypes, sourceKinds, userSamples }`（正常请求不携带）。

错误：

| 状态码 | code | 场景 |
|---|---|---|
| 400 | BAD_REQUEST | 缺 sessionId / URL 非法 |
| 403 | forbidden | 非 loopback host（`127.0.0.1` / `localhost` / `[::1]`） |
| 404 | SESSION_NOT_FOUND | session 不存在 |
| 405 | METHOD_NOT_ALLOWED | 非 GET |

### POST /better-interface/rename

Branch（Live Session）重命名，经 DSH 原生 SessionTitleService.rename。

请求体：

```json
{ "sessionId": "b-1", "title": "新名称" }
```

成功 200：

```json
{ "ok": true, "sessionId": "b-1", "title": "新名称", "seq": 42 }
```

错误：

| 状态码 | code | 场景 |
|---|---|---|
| 400 | BAD_REQUEST | 缺 sessionId / JSON body 非法 |
| 400 | TITLE_INVALID | title 全空白（本地已有前置拦截，服务端兜底） |
| 400 | SESSION_NOT_LIVE | Cold Session：请先打开该 Branch 后再重命名（不自动 resume） |
| 403 | forbidden | 非 loopback host |
| 404 | SESSION_NOT_FOUND | 持久化中也不存在 |
| 405 | METHOD_NOT_ALLOWED | 非 POST |
| 503 | RENAME_UNAVAILABLE | sessionTitle 服务缺失（索引不受影响） |
| 500 | RENAME_FAILED | 服务内部错误 |

### GET /better-interface/session-location

Phase 6「打开所在文件夹」：返回会话文件在磁盘上的绝对路径与其所在目录。

| 参数 | 必填 | 说明 |
|---|---|---|
| sessionId | ✅ | 目标 Session id（live 或 cold 均可） |

成功 200：

```json
{
  "sessionId": "s-1",
  "path": "C:\\Users\\<user>\\.dsh\\sessions\\--proj--\\session-s-1\\session.jsonl.zstd",
  "folder": "C:\\Users\\<user>\\.dsh\\sessions\\--proj--\\session-s-1",
  "kind": "jsonl",
  "live": true
}
```

- 路径来自官方 `sessionPersistence.locate(header)`（side-effect-free：不读取 / 不创建 /
  不 materialize / 不 resume / 不 open）。
- `live`：会话是否在内存（live）——header 来源 live 优先，cold 走 `persistence.list()`。
- client 打开 `folder`：优先 `ctx.remote.session.openWorkspacePath({ path: folder })`
  （官方当前通道，canOpenWorkspacePath 能力探测），旧版 DSH 回退 `ctx.workspaces.openPath`
  （2026-08 已删除，仅兼容兜底）；删除由用户手动完成。

错误：

| 状态码 | code | 场景 |
|---|---|---|
| 400 | BAD_REQUEST | 缺 sessionId / URL 非法 |
| 403 | forbidden | 非 loopback host |
| 404 | SESSION_NOT_FOUND | session 不存在（live 与持久化均无） |
| 405 | METHOD_NOT_ALLOWED | 非 GET |
| 503 | LOCATION_UNAVAILABLE | persistence 无 locate / 非单文件 backend（如 SQLite）/ locate 失败 |

### GET /better-interface/manage-sessions

Phase 6 管理界面数据源：全量会话（live+cold 合并）+ 用户视角状态。

成功 200：

```json
{
  "sessions": [
    { "sessionId": "s-1", "state": "active", "live": true, "nativeArchived": false },
    { "sessionId": "s-2", "state": "hidden", "live": false, "nativeArchived": false },
    { "sessionId": "s-3", "state": "archived", "live": false, "nativeArchived": true }
  ],
  "states": ["active", "hidden", "archived"]
}
```

- 状态缺省 `active`；`hidden` / `archived` 为**插件用户视角 metadata**（storageDomain
  域存储），不修改 JSONL / events / DSH persistence。
- `nativeArchived=true`：该会话在 DSH 原生归档集合（`workspaceRegistry.archivedSessionIds`）
  中——管理界面显示「已归档（原生）」，不可经插件恢复（无 unarchive）。
- 错误：400 / 403 / 405。

### POST /better-interface/session-state

切换会话状态（写 metadata）。

```json
{ "sessionId": "s-1", "state": "hidden" }
```

成功 200：`{ "ok": true, "sessionId": "s-1", "state": "hidden" }`

| 状态码 | code | 场景 |
|---|---|---|
| 400 | BAD_REQUEST / STATE_INVALID | 缺 sessionId / state 非法（非 active/hidden/archived） |
| 400 | NATIVE_ARCHIVED | 会话已被 DSH 原生归档（侧栏归档），无法经插件恢复 |
| 403 | forbidden | 非 loopback host |
| 404 | SESSION_NOT_FOUND | session 不存在（live 与持久化均无） |
| 405 | METHOD_NOT_ALLOWED | 非 POST |
| 503 | STATE_UNAVAILABLE | storageDomain 缺失（列表照常，切换不可用） |
| 500 | STATE_WRITE_FAILED | metadata 写入失败 |

## 调查结论（源码依据，均来自 DSH 源码，非猜测）

### cordis 依赖注入（Phase 2+ 依据，vendor/cordis 源码）

1. ctx 是 Proxy：**直接属性访问** ctx.<service> 必须先在依赖中声明该服务，
   否则抛 "cannot get property <name> without inject"（fiber 链上找不到实现时）。
2. **ctx.get(name) 是安全读取**：走 ctx.reflect.get，不要求 inject，未提供时返回 undefined。
3. 依赖声明两种方式（loader 均会读取）：模块级 export const inject / entry 行级 inject；
   **两者必须保持一致**（cordis.patch.yml 与 index.js 同步维护）。
4. 声明后 fiber 会**等待服务就绪**才运行 apply；需要服务时先声明 inject，禁止直接访问。

### Phase 3：seq → DOM 定位链路

1. Chat 消息行 DOM：`[data-chat-anchor-key="<nodeKey>"]`（ChatNodeSeat.tsx）；
   用户消息内部**无 data-seq**（UserMessageNodeView）。
2. nodeKey = 引擎 Context key（`conversationContextKey(kind, MessageId)`）——不能从 seq 构造。
3. **seq → nodeKey 映射**：`ChatConversationViewNode.anchorSeq` 携带源事件 seq，
   `snapshot.chat.nodes`（ChatSnapshot）按 key 存节点、`values()` 遍历。
   **取数双代（chatSessionOf 适配）**：
   - DSH ≥ v0.1.2（2026-08 refactor）：SessionSnapshot 明确"排除 conversation
     数据"，会话面不再带 `.chat`；chat 视图快照改经官方服务
     `ctx.get('uiConversation').binding(id).target('chat').getSnapshot()`
     （返回 ChatSnapshot，ui-chat 自己的 hooks 同源；service 需 ctx.get 懒解析，
     不进静态 inject）。
   - 旧版 DSH：`ctx.sessions.binding(id).session`（SessionFace =
     ObservableSnapshot<ConversationSnapshot>，`getSnapshot()` 读当前值）自带 `.chat`。
   两者统一归一化为 `{ chat: <ChatSnapshot> }`，翻页仍用 binding 的
   `session.loadOlder()`（新旧版 session face 都有）。
4. 长会话：client 窗口 open 拉尾部 50 条（PAGE_MESSAGES=50），`session.loadOlder()`
   每页 50 条向前 prepend；目标不在窗口 → 循环 loadOlder 直到出现或窗口不再前移。
5. **视图前提（DSH 0.2）**：对话有「对话 / 轨迹」多视图，停在轨迹视图时 Chat 不渲染
   （无 `[data-chat-node-key]` 行），定位必然失败。`ensureChatView()` 在定位前检查：
   当前不是 Chat 视图 → 点击 `[data-conversation-tabs]` 里的「对话」tab（本地化标签
   对话/Chat/聊天；找不到则依次尝试其余 tab），等两帧后重试；全部失败恢复原 tab。

### Phase 4：Branch 谱系

1. fork 谱系（dsh-session SessionStore.fork）：child.header.parentSession = 父 id，
   child.header.seedLength = seed.length（seed = 父 events.slice(0, boundary+1)，
   boundary 是父事件 inclusive seq）→ 分叉边界 seq = seedLength - 1。
2. 列直接子 Branch：SessionStore.list()（全部 live session）过滤 header.parentSession
   === 当前 id（无专门 lineage API）。
3. 分叉位置 → 用户消息：父 events 中 seq <= seedLength-1 的最后一条
   source.kind==='user' 的 user/message（boundary 本身可能是 turn/end）。
4. Branch 文本：child.firstLiveSeq（= seed 长度）之后的第一条新用户消息，
   或 session/title 标题；端点统一截断 previewChars。
5. 打开 Branch：client ctx.sessions.open(id) 原生切换；useSessions.current 变化
   → 索引自动刷新（useEffect([current])）。

### Phase 4.1：Live/Cold 枚举

1. **SessionStore.list() 只含 live**（[...this.store.values()]，dsh-session
   src/index.ts:1063）：Session/Agent 按需加载（resume 时 persistence.prepare(id)
   逐个进 store），**重启后未打开的会话是 Cold（持久化但未加载）→ list() 找不到**。
2. 官方「全量枚举」范式（subagent/list-children.ts prepareListing）：
   sessionPersistence.list() 建 corpus + sessions.list() **live 优先覆盖**（同 id 去重）。
3. **Cold 只读读取**：sessionPersistence.inspect(id) 返回不可变 { meta, events }，
   live 会话返回当前快照、cold 直接读持久化——不 resume、不发布、不改 current。
4. Cold 会话没有 firstLiveSeq 字段；持久化等价物是 log 中**最后一个**
   session/end-seed 事件的 seq + 1（lib/session.js firstLiveSeqOf，dsh-session
   Session 构造注释：seed 非 end-seed 结尾时标记 append 在 seq=seed.length；
   已以 end-seed 结尾则不重复标记）。
5. web 端 session.list RPC 直接枚举持久化（api/sessions.ts "Lists persisted
   sessions"），所以侧边栏全量可见而旧版插件索引缺 cold——两边不一致正是
   Phase 4.1 修复的根因。

### Phase 5：名称 + 重命名

1. session/title 事件 payload（dsh-session-title SessionTitleEventData）字段是
   **title**（index.ts:61-68），lib/session.js 曾误读 text（Phase 5 修复）。
2. 改名原生能力：host `session.rename` RPC → `SessionTitleService.rename(session,
   title)`（session-title/src/index.ts:363）：normalize 后空 → SessionTitleInvalidError；
   成功 append session/title（source user）→ **pins 标题**（自动生成被 supersede）；
   要求 session **live**（ctx.sessions.get(id) !== session 会抛错）。
3. client 侧 ISessions（ctx.sessions）**没有 rename**（contract/sessions.ts 只有
   open/fork/clear/search 等）→ 插件走自己的 host 端点调 sessionTitle 服务。
4. DSH 原生 RPC 对 cold 会自动 resume（agent-lookup.ts createApiRemoteAgentResolver：
   ordinary cold sessions resume once per identity）；本插件按文档 §15 **不自动 resume**，
   Cold 重命名明确拒绝。

### 删除会话

在 **设置 → BetterInterface** 先归档会话，再点击该行的「删除」并确认。插件归档和 DSH 原生归档均可。当前仍打开或被其他 DSH 进程占用的会话需要先关闭。

删除会将该会话的独立 JSONL 目录移到 DSH 会话存储根目录旁的 `better-interface-trash`。每条记录附带 `restore.json`，如需恢复，可关闭 DSH 后将其中的 `session` 目录移回 `originalPath`。其他会话和分支各自保留。

## 目录结构

```
dsh-betterInterface/
├── index.js                  # Host 入口（薄壳）：inject 声明 + 路由注册 + 组装
├── lib/
│   ├── session.js            # 纯函数（无 DSH 依赖，可单测）：索引过滤 / title / Branch 挂载推导
│   ├── pricing.js             # 解析官方价格表和计算峰谷时段
│   ├── host/
│   │   ├── guards.js         # 共用 HTTP 守卫（sendJson / isLoopback / readBody）
│   │   ├── corpus.js         # Live/Cold 合并枚举 + Branch 挂载（Phase 4.1）
│   │   ├── session-handler.js   # GET  /better-interface/session（索引 + Branch）
│   │   ├── rename-handler.js    # POST /better-interface/rename（Live 重命名）
│   │   ├── location-handler.js  # GET  /better-interface/session-location（Phase 6 📂）
│   │   ├── manage-handler.js    # GET  /manage-sessions + POST /session-state（Phase 6 状态）
│   │   └── price-monitor.js     # 价格和余额工具、价格面板数据接口
│   └── client.js             # 会话入口、设置管理及侧栏价格面板
├── cordis.patch.yml    # bundle 层：插件行声明（id/name/inject/config）
├── package.json        # 插件元数据（dsh.bundle.patch / dsh.client.platform）
├── host-test.mjs       # Host 端 38 项断言（node host-test.mjs）
├── smoke-test.mjs      # Client 结构 43 项断言（node smoke-test.mjs）
├── price-monitor.test.mjs
└── README.md
```

## 安装

```sh
git clone git@github.com:FeelinGocd/dsh-betterInterface.git
dsh plugin --profile web add ./dsh-betterInterface
```

重启 DSH Web 并刷新浏览器。若通过 DSH 源码运行，可在 DSH 仓库中使用 `pnpm dsh`，并传入插件目录的绝对路径。

已安装旧版 `dsh-better-interface` 或独立 `dsh-price-monitor` 的 profile，先移除已安装的旧包，再执行上面的安装命令。现有按 `id: price-monitor` 配置的覆盖项仍可使用。凭证继续从 DSH 的凭证服务或环境变量解析。

```sh
dsh plugin --profile web remove dsh-price-monitor
dsh plugin --profile web remove dsh-better-interface
```

## 价格和余额监控

侧栏底部显示当前峰谷时段和余额。悬停或点击可查看余额明细、高峰时段、各模型单价和最后同步时间。`price_balance` 查询余额及额度，`price_status` 查询当前峰谷状态和单价。`GET /price-monitor/status` 为本地浏览器面板提供数据。

价格和时段取自 DeepSeek 官方定价页，默认每 24 小时检查更新。余额取自官方余额接口，面板每 30 秒刷新一次，余额查询默认缓存 60 秒。

可按 `id: price-monitor` 覆盖 `cordis.patch.yml` 中的配置。

| 配置 | 默认值 | 用途 |
|---|---|---|
| `apiKeyEnv` | `DEEPSEEK_API_KEY` | DSH 凭证引用名。将密钥存入 DSH 凭证存储或设置同名环境变量。 |
| `pricingUrl` | `https://api-docs.deepseek.com/zh-cn/quick_start/pricing/` | 定价页 |
| `balanceUrl` | `https://api.deepseek.com/user/balance` | 余额接口 |
| `fetchTimeoutMs` | `15000` | 请求超时（毫秒） |
| `balanceCacheMs` | `60000` | 面板余额缓存时间（毫秒） |
| `refreshIntervalMs` | `86400000` | 定价页更新间隔（毫秒），设为 `0` 关闭定时更新。 |
| `holidays` | `[]` | 北京时间法定节假日，格式为 `YYYY-MM-DD`。若官方规则排除法定假日而日历留空，面板和 `price_status` 会提示判定限制。 |

## 开发与验证

```sh
cd dsh-betterInterface
npm test
```

- host 改动需重启 DSH（boot 快照加载）；client 改动浏览器硬刷新（Ctrl+F5）即可。
- 实机验证点：Cold Branch 重启后仍显示、多级 Branch、真实名称、✎ 行内改名（Live）/
  Cold 提示、改名不触发切换、打开定位最新、编辑态锁定、Console 无异常。

## 实现状态（对照目标文档）

| Phase | 内容 | 状态 |
|---|---|---|
| 0 | 右缘竖向圆角按钮（3 圆圈、垂直居中）+ Hover 窗口 | ✅ GUI 验证通过 |
| 2.1 | 当前 Session user/message 索引（正序、纯文本、前 30 字符、不显示 seq） | ✅ GUI 验证通过 |
| 2.1 修复 | synthetic 注入过滤 / 边缘闪烁 / 首帧错位 / 加载闪烁 | ✅ GUI 验证通过 |
| 3 | 点击索引 → 滚动定位对应消息（含长会话 loadOlder 翻页、单行、hover 边框、轨迹视图自动切回） | ✅ 已修复（v0.1.2 chatSessionOf + v0.2 当前会话标记 + 视图回退；smoke 44 / GUI 实测通过） |
| 3.1 | 点击定位后保持窗口（用户决策） | ✅ GUI 验证通过 |
| 4 | Branch 发现/挂载/展示/点击切换 Session（○/● 展开、降级） | ✅ 已实现（host+smoke 全绿，待 GUI 验证） |
| 4.1 | Live/Cold 合并枚举（sessionPersistence + sessions）、多级 Branch、Cold 不 resume | ✅ 已实现（待 GUI 验证） |
| 5 | Branch 真实名称（title 优先 + fallback）、行内重命名（✎ → input + ✓/✕）、Live 改名 / Cold 拒绝 | ✅ 已实现（host 24 / smoke 24 / boot 全绿，待 GUI 验证） |
| 5.1 | 编辑态锁定（IME/mouseleave 不关闭）+ 打开定位最新 | ✅ 已实现（用户反馈修复完成，待 GUI 验证） |
| 6 | 打开所在文件夹（📂：Branch 项 + 当前会话 + 设置页；locate → openFolderNative：≥v0.1.2 remote.session / 旧版兜底，用户手动删除） | ✅ 已实现（host 28 / smoke 43 / boot 全绿，DSH v0.1.2/v0.2 迁移适配，待 GUI 验证） |
| 6 | 设置面板管理界面（「BetterInterface」导航条目 → 列表/过滤/隐藏/归档/恢复/📂；storageDomain metadata） | ✅ 已实现（host 34 / smoke 32 / boot 全绿，待 GUI 验证） |
| 6 联动 | 状态联动索引：hidden/archived 的 Branch 从悬浮窗索引过滤，恢复后重现 | ✅ 已实现（host 36 / boot 联动探测通过，待 GUI 验证） |
| 6 原生归档 | 合并 workspaceRegistry.archivedSessionIds：管理界面可见（已归档（原生））、索引过滤、切换拒绝 | ✅ 已实现（host 36 / smoke 33 / boot 全绿，待 GUI 验证） |
| 7 | Chat 用户长消息折叠（>5 行气泡折叠 + 左下角 ▲/▼ 展开收起按钮；user + steering） | ✅ 已实现（smoke 43 / GUI 实测折叠真实 11k 字符消息通过） |
| 6.6 | 侧栏 DOM 隐藏（hidden 会话从左侧栏隐藏，标题匹配 + observer 兜底，可恢复） | ✅ 已实现（smoke 35 全绿，待 GUI 验证） |
| 0.2 | DSH v0.2.1 兼容：当前会话 mainView 推导、Branch 切换走 uiWorkspace.openSession、Host Session snapshotEvents()、sessionPersistence list 快照 / inspect→open.read、设置页全局 hooks | ✅ host 38 / smoke 43 全绿（待 GUI 验证） |
| — | Edit → Branch 等后续阶段 | ⏸ 暂停（用户未启动） |
| — | 安装 + GUI 冒烟 | ⏳ 待执行（重启 DSH + 浏览器硬刷新） |

## 已知边界

- profile 的 cordis.patch.yml 与 package.json 必须保持插件在册；执行 dsh plugin / pnpm
  操作后建议复核 dsh.profile.bundles 是否仍含 dsh-better-interface。
- **inject 双声明同步**：模块级 export const inject（index.js）与 cordis.patch.yml 行级
  inject 必须一致（当前均为 webServer / sessions / sessionPersistence / sessionTitle）。
- 定位依赖 `chatSessionOf(ctx, current)` 取会话快照：≥v0.1.2 用
  `ctx.get('uiConversation').binding(id).target('chat')`（cordis 安全读取、不要求
  inject），旧版回退 `ctx.sessions.binding(current).session.getSnapshot()`；两者都
  归一化 `{ chat }`（旧版 session 面自带 chat；新版 SessionSnapshot 已排除
  conversation 数据，必须走 uiConversation）。staged 会话才有绑定；binding 缺失或
  快照中无对应节点时只打 `[dsh-conversation-flow] Unable to locate message: seq=N`，
  不崩溃。
- 定位前需 Chat 视图已渲染：DSH 0.2 的「轨迹」视图不渲染 Chat DOM，点击索引会先由
  `ensureChatView()` 自动切回「对话」tab 再定位（本地化标签 对话/Chat/聊天/Conversation；
  其它语言或自定义视图按注册顺序兜底，全部失败恢复原视图）。若目标消息已被
  compaction 等替换操作移出 surface，则数据层即无对应节点，仍会报 Unable to locate
  （索引来自完整事件日志，Chat 只渲染当前 surface）。
- Branch 谱系经 sessionPersistence.list() + sessions.list() 合并计算（live 优先）；
  persistence 缺失/list 抛错 → branchAvailable=false，索引与 live 分支照常（Phase 4.1
  安全降级）；单个 cold child inspect 失败 → 跳过该 child + warn，其余分支不受影响。
- Branch 名称 title 优先（session/title data.title），无 title 回退首条新用户消息。
- 重命名仅支持 Live Session（POST /better-interface/rename）：Cold → 400
  SESSION_NOT_LIVE「请先打开该 Branch 后再重命名」；sessionTitle 服务缺失 → 503
  RENAME_UNAVAILABLE（索引照常）；空标题 → 400 TITLE_INVALID；未知 session → 404。
- 重命名是 DSH 原生行为：append session/title（source user）pins 标题，不修改历史 events。
- Branch 挂载规则：seedLength-1 边界前的最后一条真实用户消息；boundary 前无用户消息
  的 child 被忽略（如只有 synthetic 注入的分叉）；多级 Branch 沿 parentSession 逐级发现。
- 长会话点击早期消息会连续 loadOlder（每 50 条一次请求），体验受网络与窗口大小影响；
  翻页之间会让出一帧（等 React 渲染完本页 DOM 再翻下一页），避免同步插入大量 DOM
  卡顿主线程；翻页后也等一帧再查询 DOM（防止行未挂载导致误报 Unable to locate）。
- **storageDomain 单元名（踩坑教训）**：域/表名必须匹配 `UNIT_NAME_RE`
  （`/^[a-z][a-z0-9_]*$/`）——**不能用连字符**；插件域名为 `better_interface`
  （官方 `message_feedback` 同款下划线）。曾用 `better-interface` 导致
  `storageDomain.open()` 抛错、状态管理静默降级为 503（列表照常、点击无效）。
  host-test 已加 domain name 合规断言（38 项）。
- **状态语义（Phase 6）**：`hidden` / `archived` 是**插件用户视角状态**（storageDomain
  metadata），**已联动悬浮窗索引**：被隐藏/归档的 Branch 从索引中过滤（corpus 层
  `buildBranchCorpus` 过滤 child，当前会话本身不受影响——你正在看它）；设置面板
  管理界面按状态分组/过滤。恢复 = 切回 `active`（索引重新出现）。
- **管理界面名称显示**：每行显示 `SessionSummary.displayTitle`（settings.section 标准
  props `useSessions`，与侧栏同源）+ 所属工作区（`useWorkspaces` 的 `workspace.title`）+
  sessionId；标准数据不可用时降级只显示 sessionId。名称不可改名（改名走 Branch 重命名 / DSH 原生）。
- **管理界面分组**：按 `useWorkspaces` 的 workspace（title + sessionIds）分组，组头
  ▾/▸ 折叠展开、显示会话数；不在任何工作区的会话进「未分组」。过滤 tabs（全部/
  已隐藏/已归档/非活跃）作用于分组后的成员（空组不显示成员）。
- **原生归档联动（Phase 6）**：管理界面合并 `workspaceRegistry.archivedSessionIds`——
  侧栏原生归档的会话显示为「已归档（原生）」（无恢复按钮，DSH 无 unarchive API；
  `POST session-state` → 400 NATIVE_ARCHIVED）；原生归档的 Branch 同样从悬浮窗索引过滤。
  归档集合为动态读取（每次请求取最新，不缓存 apply 快照）。
- **设置面板入口**：settings.section 仅一个条目「BetterInterface」（order 21）位于 Agent
  预设（order 20）下方；与官方导航样式一致（齿轮图标由 shell 按未知 id 回退提供）。
  注：DSH 设置导航的每个条目都是可点击按钮（自动配图标），无法做"无图标的纯提示
  文字"条目，因此不注册"插件管理"提示项。
- **打开文件夹通道（DSH ≥ v0.1.2 修复）**：旧 client 服务 `ctx.workspaces.openPath`
  在 2026-08 client refactor（dsh-v0.1.2-alpha.1，workspaces 迁入
  api/workspace-controller）中删除；插件 📂（设置页/悬浮窗头部/Branch）统一走
  `openFolderNative()`——优先 `ctx.get('remote.session')`（cordis 安全读取，不进
  静态 inject）的 `canOpenWorkspacePath()/openWorkspacePath({ path })`（官方当前
  通道，host 侧 SessionController → 原生打开器），旧版 DSH 自动回退
  `ctx.workspaces.openPath`。两通道均缺失或能力探测 false → console 报错、不崩溃。
- **Host Session 事件读取（DSH ≥ v0.2）**：0.2 把 Host `Session` 的事件日志设为私有
  （只有 `.surface.nodes` 序号），公开读取改为 `session.snapshotEvents()`（官方
  session-query 同款；`.events` 不再存在）。插件统一经 `sessionEventsOf()` 读取，
  否则悬浮窗索引与 Branch 对 live 会话恒为空（旧版回退 `.events`）。
- **sessionPersistence 形状（DSH ≥ v0.2）**：`sessionPersistence.list()` 的返回从
  `SessionHeader[]` 变为 `SessionPersistenceSnapshot[]`（`{ header, formatStatus,
  revision, sizeBytes }`），且 `inspect()` 被移除（冷会话读取改走
  `open(id, 'read')` + `handle.read()`）。插件统一经 `persistedHeaderOf()` 归一化，
  冷分支事件优先旧的 `inspect()`、缺失时用只读 handle；否则管理页/索引只剩
  live 会话（旧版 DSH 仍兼容）。
- **会话导航与当前会话（DSH ≥ v0.2 兼容）**：v0.2 起 `ISessions.open` 被删除、
  `SessionListState` 不再有 `current` 字段。插件改为：
  - 当前会话 = `byId[id].retainedBy.mainView > 0`（官方 ui-agent-preset 同款判定），
    旧版回退 `listState.current`（`currentSessionIdOf()`）；
  - DOM 行定位优先 `[data-chat-node-key]`（v0.2 原始 node key），回退
    `[data-chat-anchor-key]`（v0.2 的 turn-process 分组行会带 groupPart 后缀）；
  - 点击 Branch 切换 = `ctx.get('uiWorkspace').openSession(id)`（官方当前导航，
    ui-layout/ui-workspace 组合中必有），旧版回退 `ctx.sessions.open(id)`
    （`openSessionNative()`）；两通道均缺失 → Console 报错、不崩溃。
  - 设置页 `useSessions`/`useWorkspaces` 现由框架 GlobalStandardProps 统一下发
    （原先按 owner props 猜测），管理页名称/工作区分组因此恢复正常。
- **侧栏 DOM 隐藏（Phase 6.6）**：DSH 官方 API 无 unarchive（workspace 注释
  "a future unarchive restores its position"），侧栏 = 全量会话 − 原生归档；
  插件 hidden 只过滤自己的视图。因此侧栏隐藏用**纯 client DOM 注入**：
  manage-sessions 取 hidden id → `ctx.sessions.list.getSnapshot().byId` 映射
  displayTitle（与侧栏同源）→ 匹配 `[role="treeitem"]` 行内 span 文本
  （**精确相等 + trim**）→ `display:none` + `data-sbi-sidebar-hidden` 标记；
  React 重建行由 MutationObserver（body, rAF 节流）兜底重新隐藏；恢复
  active 取消。触发：状态切换/改名成功后 `dsh-bi-state-changed` 事件。
  **已知限制**：重名会话会一起隐藏（建议重命名区分）；workspace 行标题
  与 hidden 标题相同会误隐藏（概率极低）。
- **长消息折叠（Phase 7）**：仅作用于 Chat 用户气泡
  （`[data-chat-flow-kind="user"], [data-chat-flow-kind="steering"]`；上下文注入
  `context`/`turn-trigger` 不折叠），
  折叠对象是气泡本身（findBubble：非透明背景 + 圆角特征选气泡，fallback 最大含文本
  块——整行 scrollHeight 含 actions 等非文本元素会误判 3 行短消息）；3 行及以下
  **绝不折叠**（放宽预判 ≥(N-1) 行 + 折叠自检撤销）；按钮 inline position:relative
  持久化锚定气泡左下角（展开后 `.sbi-fold` class 移除也不脱离、跟随滚动）；折叠/展开
  纯 DOM 操作（stopPropagation），不触发任何 DSH 事件、不替换官方渲染器。
- 无会话 → "暂无对话数据"；有会话但无消息 → "暂无用户消息"；端点失败 → Console 报错 + "暂无对话数据"。
