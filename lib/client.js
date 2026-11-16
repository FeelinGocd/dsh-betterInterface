/**
 * dsh-better-interface — browser half (Phase 3: click index -> locate message).
 *
 * Single registration in `shell.overlay` (the official "plugin-owned
 * floating layer" seat): a thin vertical rounded rail pinned to the right
 * edge of the viewport, vertically centered, decorated with three dots.
 * Hovering the rail reveals a small rounded panel to its LEFT listing the
 * CURRENT session's user messages (oldest first, plain text previews).
 *
 * Phase 3 scope: clicking an index item scrolls the Chat view to the matching
 * user message. Mapping (confirmed from DSH source, no guessing):
 *   - Chat rows are `<div data-chat-anchor-key="<nodeKey>">` (ChatNodeSeat);
 *     the node key is an engine Context key (kind + MessageId) — it CANNOT be
 *     derived from the event seq.
 *   - `ChatConversationViewNode.anchorSeq` carries the source event seq, and
 *     `snapshot.chat.nodes` (`ChatNodeStore.values(): ChatConversationViewNode[]`)
 *     exposes the node — so seq -> nodeKey -> DOM row is the mapping. Two DSH
 *     generations supply that snapshot (chatSessionOf() adapts both):
 *       · DSH >= v0.1.2 (2026-08 refactor): SessionSnapshot excludes conversation
 *         data; read the chat view via
 *         `ctx.get('uiConversation').binding(id).target('chat').getSnapshot()`
 *         (the same source ui-chat's own hooks use, apply.ts chatSource).
 *       · older DSH: `ctx.sessions.binding(id).session.getSnapshot()`
 *         (`ObservableSnapshot<ConversationSnapshot>`) already carries .chat.
 *     loadOlder() lives on both session faces (paging).
 *   - Long sessions page history: the client window opens at the tail
 *     (PAGE_MESSAGES=50) and `session.loadOlder()` prepends one earlier page
 *     per call. If the target is not in the current window we loop loadOlder
 *     until it appears or the window stops advancing (end of history).
 *   - No highlight / animation / dialog (Phase 3 spec); failure only logs
 *     `[dsh-conversation-flow] Unable to locate message: seq=N`.
 *   - Index rows are single-line ellipsized text; hovering wraps the row in the
 *     grey/white bordered box used by the Settings trigger / PriceMonitor
 *     (`--dsw-alias-interactive-bg-hover` background + l2 border, 8px radius).
 *   - Locating waits for a render frame after loadOlder pages land, so the
 *     newly prepended rows exist in the DOM before querying (also spreads the
 *     page-prepend DOM work across frames instead of blocking the main thread).
 *
 * Phase 4 (Branch navigation): each index row shows a toggle on the right —
 *   ○ (no branch, click does nothing) or ● (branches exist, click expands the
 *   list under the row). The branch list is computed by the Host from the DSH
 *   fork lineage (child.header.parentSession + seedLength), anchored to the
 *   last user message before the fork boundary (seedLength - 1). Clicking a
 *   branch opens that Session through the native session-navigation command
 *   (DSH >= v0.2: ctx.uiWorkspace.openSession(id); older: ctx.sessions.open(id)),
 *   and the index re-renders for the new current session automatically. The
 *   toggle's click stops propagation, so expanding branches never triggers
 *   the Phase 3 message jump. If the lineage API is unavailable the index
 *   still works (rows render ○) and a console warning is emitted.
 *
 * Phase 5 (Branch name + rename): Branch rows show the session's real name
 *   (host computes title-first, fallback first new user message). Hovering a
 *   Branch row reveals a ✎ rename button; clicking it swaps the row to an
 *   inline input + ✓ save / ✕ cancel. Saving POSTs to /better-interface/rename
 *   (host → SessionTitleService.rename) and refreshes the index on success;
 *   failures show a lightweight inline error. All rename controls stop
 *   propagation, so they never trigger the Branch switch or the Phase 3 jump;
 *   while editing, clicking the row does nothing.
 *
 * Phase 5.1 (UX fixes):
 *   - Rename editing LOCKS the hover window: while renamingSeq is set,
 *     armClose() clears any pending close timer and returns, so an IME
 *     candidate window or a stray mouseleave cannot close the panel mid-edit.
 *   - Each re-open (first hover of a session) scrolls the panel to the BOTTOM
 *     (newest messages), since the index is oldest-first; the first load and
 *     session switches also scroll to bottom, while silent refreshes keep the
 *     user's position.
 *
 * Phase 6 (open folder): Branch rows, the popup header, and the settings
 *   manage page expose a 📂 button; clicking it fetches
 *   /better-interface/session-location (the Host resolves the session's file
 *   path via sessionPersistence.locate — a side-effect-free locator, no
 *   materialize/resume/open) and opens the containing folder. The opener is
 *   openFolderNative(): DSH >= v0.1.2 (2026-08 refactor) removed the legacy
 *   client ctx.workspaces.openPath, so the folder is opened through the
 *   current official channel ctx.remote.session.canOpenWorkspacePath() /
 *   ctx.remote.session.openWorkspacePath({ path }) (the same Remote namespace
 *   the official UI uses); on older DSH builds it falls back to
 *   ctx.workspaces.openPath(folder). Both are resolved lazily via ctx.get()
 *   (safe read, no static inject), so the plugin works on either DSH. The
 *   settings page also lets users move an archived, closed session to local trash.
 *
 * UI stability notes (user-reported fixes):
 *  - The popup is ALWAYS mounted; hover only toggles opacity/visibility via
 *    the `.sbi-hover` class on the root. Inserting/removing the element on
 *    hover could show it at an intermediate layout position (the "appears
 *    at the bottom-right, then jumps left" flicker); a permanently mounted
 *    popup can never move, and the open animation is opacity-only.
 *  - The 12px gap between rail and popup used to be a dead zone: crossing
 *    it fired rail mouseleave -> popup closed -> re-enter -> reopen, a
 *    rapid flicker while the cursor sat near the panel edge. A rail
 *    ::after bridge (only shown while hovering) makes the gap part of the
 *    rail hit area, so rail<->popup travel never drops the hover.
 *  - Loading is silent once data exists (no "加载中…" flicker).
 *
 * Plain browser JS: no JSX, no TypeScript, no module imports. React is
 * resolved from the platform module table via the injected require. CSS is
 * injected through a <style data-plugin> tag; every rule is scoped under
 * [data-plugin="dsh-better-interface"] (root carries the attribute).
 */

window.__ModuleLoader__.load({
  id: 'dsh-better-interface',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var React = require('react')

    var PLUGIN_ID = 'dsh-better-interface'
    var SCOPE = '[data-plugin="' + PLUGIN_ID + '"]'
    var HOVER_GRACE_MS = 220
    var LOCATE_MAX_PAGES = 300   // loadOlder 翻页上限（300 * 50 = 15000 条历史，防死循环）

    // ── CSS ────────────────────────────────────────────────────────────────
    // The rail rides shell.overlay, whose layer is click-through by design;
    // only the rail and the popup opt back into pointer events. Child rules
    // are DESCENDANT selectors under the data-plugin root (same-element
    // selectors would silently drop the rail positioning).
    var CSS = [
      // Root: invisible full-viewport layer that never intercepts clicks.
      SCOPE + '.sbi-root{position:fixed;inset:0;pointer-events:none;z-index:60}',
      // ── Rail: 竖向细长圆角按钮（右缘垂直居中，三个圆圈）──
      SCOPE + '.sbi-root .sbi-rail{position:absolute;right:8px;top:50%;transform:translateY(-50%);pointer-events:auto;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:7px;width:16px;padding:12px 0;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,0.10));background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,0.9));box-shadow:var(--dsw-shadow-lv1,0 2px 8px rgba(0,0,0,0.10));cursor:pointer;transition:background .15s ease,box-shadow .15s ease}',
      // Hover 时 rail 向左伸出 14px 透明桥接，覆盖 rail 与 popup 之间的缝隙，
      // 鼠标在 rail↔popup 间移动不会离开 hover（防边缘闪烁）。
      SCOPE + ".sbi-root .sbi-rail::after{content:'';position:absolute;top:-8px;bottom:-8px;right:100%;width:14px;display:none}",
      SCOPE + '.sbi-root .sbi-rail:hover::after{display:block}',
      SCOPE + '.sbi-root .sbi-rail:hover{background:var(--dsw-alias-bg-layer-3,#fff);box-shadow:var(--dsw-shadow-lv2,0 4px 14px rgba(0,0,0,0.16))}',
      SCOPE + '.sbi-root .sbi-dot{display:block;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-tertiary,#999);transition:background .15s ease;flex:none}',
      SCOPE + '.sbi-root .sbi-rail:hover .sbi-dot{background:var(--dsw-alias-accent,#2f6fed)}',
      // ── Popup: 按钮左侧展开的索引窗口（常驻 DOM，hover 切换可见性）──
      SCOPE + '.sbi-root .sbi-pop{position:absolute;right:36px;top:50%;transform:translateY(-50%);width:272px;max-height:min(62vh,560px);overflow-y:auto;opacity:0;visibility:hidden;pointer-events:none;background:var(--dsw-alias-bg-layer-2,#fff);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,0.10));border-radius:12px;box-shadow:var(--dsw-shadow-lv2,0 8px 24px rgba(0,0,0,0.16));color:var(--dsw-alias-label-primary,#222);font-size:13px;line-height:20px;transition:opacity .12s ease,visibility .12s ease}',
      SCOPE + '.sbi-root.sbi-hover .sbi-pop{opacity:1;visibility:visible;pointer-events:auto}',
      SCOPE + '.sbi-root .sbi-pop-head{position:sticky;top:0;z-index:1;display:flex;align-items:center;justify-content:space-between;gap:6px;padding:9px 14px 7px;font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary,#999);border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,0.06));background:inherit;border-radius:12px 12px 0 0}',
      SCOPE + '.sbi-root .sbi-head-folder{flex:none;width:18px;height:18px;display:flex;align-items:center;justify-content:center;border:none;background:none;padding:0;border-radius:6px;cursor:pointer;color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:1;transition:color .15s ease,background .15s ease}',
      SCOPE + '.sbi-root .sbi-head-folder:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,0.05));color:var(--dsw-alias-accent,#2f6fed)}',
      // 消息条目（Phase 3：可点击定位；hover 灰白边框包裹——参照 PriceMonitor / Settings 触发器；
      // 文本单行省略；Phase 4：右侧 Branch 展开按钮 ○/●）
      SCOPE + '.sbi-root .sbi-item{display:flex;align-items:center;gap:8px;padding:8px 12px;margin:2px 8px;border-radius:8px;border:1px solid transparent;cursor:pointer;transition:background .15s ease,border-color .15s ease}',
      SCOPE + '.sbi-root .sbi-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,0.05));border-color:var(--dsw-alias-border-l2,rgba(0,0,0,0.10))}',
      SCOPE + '.sbi-root .sbi-item-text{flex:1;min-width:0;font-size:12px;color:var(--dsw-alias-label-secondary,#555);overflow:hidden;white-space:nowrap;text-overflow:ellipsis;pointer-events:none}',
      // Branch 展开按钮：○（无分支，点击无效果）／●（有分支，点击展开）
      SCOPE + '.sbi-root .sbi-branch-toggle{flex:none;width:18px;height:18px;display:flex;align-items:center;justify-content:center;border:none;background:none;padding:0;border-radius:6px;cursor:pointer;color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:1;transition:color .15s ease,background .15s ease}',
      SCOPE + '.sbi-root .sbi-branch-toggle:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,0.05))}',
      SCOPE + '.sbi-root .sbi-branch-toggle-on{color:var(--dsw-alias-accent,#2f6fed)}',
      // Branch 列表：消息下方缩进展开；条目 hover 同样灰白边框包裹
      SCOPE + '.sbi-root .sbi-branch-list{margin:0 8px 4px 22px;padding:2px 0 2px 10px;border-left:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,0.08));display:flex;flex-direction:column;gap:2px}',
      SCOPE + '.sbi-root .sbi-branch-item{display:flex;align-items:center;gap:6px;width:100%;text-align:left;box-sizing:border-box;border:1px solid transparent;background:none;padding:5px 8px;border-radius:8px;cursor:pointer;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#555);overflow:hidden;white-space:nowrap;text-overflow:ellipsis;transition:background .15s ease,border-color .15s ease}',
      SCOPE + '.sbi-root .sbi-branch-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,0.05));border-color:var(--dsw-alias-border-l2,rgba(0,0,0,0.10))}',
      SCOPE + '.sbi-root .sbi-branch-mark{flex:none;color:var(--dsw-alias-label-tertiary,#999)}',
      SCOPE + '.sbi-root .sbi-branch-text{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}',
      // Phase 5：Branch 重命名（✎ hover 显示 → 行内输入 + ✓/取消 + 错误提示）
      SCOPE + '.sbi-root .sbi-branch-rename{flex:none;width:18px;height:18px;display:flex;align-items:center;justify-content:center;border:none;background:none;padding:0;border-radius:6px;cursor:pointer;color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:1;opacity:0;transition:opacity .12s ease,color .15s ease,background .15s ease}',
      SCOPE + '.sbi-root .sbi-branch-item:hover .sbi-branch-rename{opacity:1}',
      SCOPE + '.sbi-root .sbi-branch-rename:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,0.05));color:var(--dsw-alias-accent,#2f6fed)}',
      // Phase 6：打开所在文件夹（📂，hover 显示，与 ✎ 同款）
      SCOPE + '.sbi-root .sbi-branch-folder{flex:none;width:18px;height:18px;display:flex;align-items:center;justify-content:center;border:none;background:none;padding:0;border-radius:6px;cursor:pointer;color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:1;opacity:0;transition:opacity .12s ease,color .15s ease,background .15s ease}',
      SCOPE + '.sbi-root .sbi-branch-item:hover .sbi-branch-folder{opacity:1}',
      SCOPE + '.sbi-root .sbi-branch-folder:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,0.05));color:var(--dsw-alias-accent,#2f6fed)}',
      SCOPE + '.sbi-root .sbi-branch-edit{flex:1;min-width:0;display:flex;flex-wrap:wrap;align-items:center;gap:4px}',
      SCOPE + '.sbi-root .sbi-branch-input{flex:1;min-width:0;font-size:12px;line-height:18px;padding:3px 6px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,0.10));border-radius:6px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#222);outline:none}',
      SCOPE + '.sbi-root .sbi-branch-input:focus{border-color:var(--dsw-alias-accent,#2f6fed)}',
      SCOPE + '.sbi-root .sbi-branch-save,.sbi-root .sbi-branch-cancel{flex:none;width:20px;height:20px;display:flex;align-items:center;justify-content:center;border:none;background:none;padding:0;border-radius:6px;cursor:pointer;font-size:12px;line-height:1}',
      SCOPE + '.sbi-root .sbi-branch-save{color:var(--dsw-alias-accent,#2f6fed)}',
      SCOPE + '.sbi-root .sbi-branch-cancel{color:var(--dsw-alias-label-tertiary,#999)}',
      SCOPE + '.sbi-root .sbi-branch-save:hover,.sbi-root .sbi-branch-cancel:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,0.05))}',
      SCOPE + '.sbi-root .sbi-branch-error{flex-basis:100%;font-size:11px;line-height:14px;color:var(--dsw-alias-danger,#d93026);margin-top:2px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}',
      SCOPE + '.sbi-root .sbi-hint{padding:18px 14px;color:var(--dsw-alias-label-tertiary,#999);font-size:12px;text-align:center}',
      // ── Phase 6：设置面板内管理界面（settings.section）──
      // 根元素带 data-plugin；内部 .sbi-manage* 用后代选择器作用域隔离。
      SCOPE + ' .sbi-manage-root{padding:2px 0}',
      SCOPE + ' .sbi-manage{display:flex;flex-direction:column;gap:8px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary,#222)}',
      SCOPE + ' .sbi-manage-title{font-size:15px;font-weight:600}',
      SCOPE + ' .sbi-manage-sub{font-size:12px;color:var(--dsw-alias-label-tertiary,#999)}',
      SCOPE + ' .sbi-manage-filters{display:flex;gap:6px;flex-wrap:wrap}',
      SCOPE + ' .sbi-manage-filter{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,0.10));background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-secondary,#555);border-radius:999px;padding:2px 10px;font-size:12px;cursor:pointer;transition:border-color .15s ease,color .15s ease}',
      SCOPE + ' .sbi-manage-filter-on{border-color:var(--dsw-alias-accent,#2f6fed);color:var(--dsw-alias-accent,#2f6fed)}',
      SCOPE + ' .sbi-manage-list{display:flex;flex-direction:column;gap:2px;max-height:46vh;overflow-y:auto}',
      // 工作区分组：分组头（▾ 标题 数量）+ 组内会话（缩进）
      SCOPE + ' .sbi-manage-group{display:flex;flex-direction:column;gap:2px}',
      SCOPE + ' .sbi-manage-group-head{display:flex;align-items:center;gap:6px;width:100%;text-align:left;border:none;background:none;padding:5px 6px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary,#222);transition:background .15s ease}',
      SCOPE + ' .sbi-manage-group-head:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,0.05))}',
      SCOPE + ' .sbi-manage-group-caret{flex:none;width:12px;color:var(--dsw-alias-label-tertiary,#999)}',
      SCOPE + ' .sbi-manage-group-count{color:var(--dsw-alias-label-tertiary,#999);font-weight:400}',
      SCOPE + ' .sbi-manage-group-body{display:flex;flex-direction:column;gap:4px;padding-left:14px}',
      SCOPE + ' .sbi-manage-row{display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,0.06));border-radius:8px}',
      SCOPE + ' .sbi-manage-state{flex:none;font-size:11px;padding:1px 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,#f5f5f5);color:var(--dsw-alias-label-secondary,#555)}',
      SCOPE + ' .sbi-manage-state-hidden{background:rgba(0,0,0,0.08);color:var(--dsw-alias-label-tertiary,#999)}',
      SCOPE + ' .sbi-manage-state-archived{background:rgba(217,48,38,0.10);color:var(--dsw-alias-danger,#d93026)}',
      SCOPE + ' .sbi-manage-id{flex:1;min-width:0;overflow:hidden}',
      SCOPE + ' .sbi-manage-name{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary,#222);overflow:hidden;white-space:nowrap;text-overflow:ellipsis}',
      SCOPE + ' .sbi-manage-meta{font-size:11px;color:var(--dsw-alias-label-tertiary,#999);overflow:hidden;white-space:nowrap;text-overflow:ellipsis}',
      SCOPE + ' .sbi-manage-actions{flex:none;display:flex;gap:4px}',
      SCOPE + ' .sbi-manage-act{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,0.10));background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-secondary,#555);border-radius:6px;padding:1px 7px;font-size:11px;cursor:pointer}',
      SCOPE + ' .sbi-manage-act:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,0.05))}',
      SCOPE + ' .sbi-manage-hint{padding:14px 4px;color:var(--dsw-alias-label-tertiary,#999);font-size:12px;text-align:center}',
      // ── Phase 6.5：Chat 用户长消息折叠（保留官方渲染器 + CSS/DOM 注入）──
      // 折叠目标 = 用户消息行内的最大文本块（气泡），而非整个行（行含 actions
      // 等非文本元素，折叠行会误判 + 裁剪难看）。行选择器 [data-chat-flow-kind="user"]
      // 由 JS 使用；.sbi-fold 通用 class 作用在文本块上（max-height 由 JS 注入）。
      '.sbi-fold{position:relative;overflow:hidden}',
      // 折叠底部渐变遮罩（淡出而非硬切）；按钮 z-index 更高浮在遮罩上
      '.sbi-fold::after{content:"";position:absolute;left:0;right:0;bottom:0;height:36px;background:linear-gradient(to bottom,rgba(0,0,0,0),var(--dsw-alias-bg-layer-1,rgba(255,255,255,0.92)));pointer-events:none;z-index:2}',
      '.sbi-fold-btn{position:absolute;left:10px;bottom:8px;z-index:4;background:transparent;border:none;color:rgba(102,102,102,0.35);font-size:16px;line-height:18px;font-weight:600;padding:6px 10px;border-radius:8px;cursor:pointer;font-family:inherit;transition:color .15s ease}',
      '.sbi-fold-btn:hover{background:transparent;color:rgba(51,51,51,0.6)}',
    ].join('')
    var CSS_ID = PLUGIN_ID + '/panel.css'
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="' + CSS_ID + '"]') === null) {
      var tag = document.createElement('style')
      tag.dataset.plugin = PLUGIN_ID
      tag.dataset.pluginCss = CSS_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    // ── 定位辅助（纯逻辑，导出 __test 供结构测试）──────────────────────────
    // 快照结构（DSH client runtime contract/conversation.ts）：
    //   ChatSnapshot = { order: string[], nodes: ChatNodeStore, ... }
    //   ChatNodeStore.values(): ChatConversationViewNode[]
    //   ChatConversationViewNode = { key, kind, anchorSeq, location, visibility, data }
    // 在快照 chat 节点中按源事件 seq 查找（anchorSeq === seq）。
    function findNodeBySeq(snapshot, seq) {
      if (snapshot === null || snapshot === undefined || !snapshot.chat) return null
      var nodes = snapshot.chat.nodes
      if (nodes === null || nodes === undefined || typeof nodes.values !== 'function') return null
      var list = nodes.values()
      for (var i = 0; i < list.length; i++) {
        var node = list[i]
        if (node !== null && node !== undefined && node.anchorSeq === seq) return node
      }
      return null
    }

    // 窗口内最小 anchorSeq（近似历史窗口起点；用于判断是否还需向前翻页）。
    function minAnchorSeq(snapshot) {
      if (snapshot === null || snapshot === undefined || !snapshot.chat) return null
      var nodes = snapshot.chat.nodes
      if (nodes === null || nodes === undefined || typeof nodes.values !== 'function') return null
      var list = nodes.values()
      var min = null
      for (var i = 0; i < list.length; i++) {
        var node = list[i]
        if (node === null || node === undefined || typeof node.anchorSeq !== 'number') continue
        if (min === null || node.anchorSeq < min) min = node.anchorSeq
      }
      return min
    }

    // node.key -> DOM 行 -> scrollIntoView。
    // DSH ≥ v0.2 的行同时带 [data-chat-node-key]（原始 node key）与
    // [data-chat-anchor-key]（turn-process 分组时可能带 groupPart 后缀）——
    // 优先用 node-key 精确命中，旧版行只有 anchor-key 时回退。
    // 返回是否真正定位并滚动成功。
    function scrollToNode(node) {
      if (node === null || node === undefined || typeof node.key !== 'string' || node.key === '') return false
      var escaped = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
        ? CSS.escape(node.key)
        : node.key.replace(/"/g, '\\"')
      var selectors = [
        '[data-chat-node-key="' + escaped + '"]',
        '[data-chat-anchor-key="' + escaped + '"]',
      ]
      var row = null
      for (var si = 0; si < selectors.length && row === null; si++) {
        try {
          row = document.querySelector(selectors[si])
        } catch (e) { row = null }
      }
      if (row === null || row === undefined) return false
      if (typeof row.scrollIntoView === 'function') {
        try {
          row.scrollIntoView({ behavior: 'smooth', block: 'center' })
        } catch (e) { return false }
      }
      return true
    }

    // 等待浏览器完成当前帧的渲染/布局后再查 DOM：
    //  - 翻页（loadOlder prepend）的新行要一帧才会挂载到 DOM，立即 querySelector
    //    会拿不到行而误报"Unable to locate"；
    //  - 连续翻页之间也让出一帧，避免同步插入大量 DOM 阻塞主线程造成的卡顿。
    function nextFrame() {
      return new Promise(function (resolve) {
        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(function () { requestAnimationFrame(resolve) })
        } else {
          setTimeout(resolve, 0)
        }
      })
    }

    // ── Phase 3 修复：聊天节点快照取数（DSH v0.1.2 起 SessionSnapshot 不再含
    // conversation 数据）──────────────────────────────────────────────
    // 旧 DSH：ctx.sessions.binding(id).session.getSnapshot() 返回
    //   { chat: { nodes: { values(): ChatConversationViewNode[] }, ... } }。
    // DSH ≥ v0.1.2（2026-08 client refactor）：conversation 数据拆到
    //   ctx.uiConversation（官方服务）的 binding(id).target('chat')，
    //   返回 ChatSnapshot（结构同上：nodes.values() 的节点含 key/anchorSeq）；
    //   SessionSnapshot 已明确"排除 conversation 数据"，直接读不到。
    // 两通道都用 ctx.get() 懒解析（cordis 安全读取，不要求 inject，缺服务返回
    // undefined——避免静态 inject 缺失服务在旧 DSH 上挂起整个插件）。
    // 统一返回"session 形"对象：getSnapshot() 归一化为 { chat: <snapshot> }，
    // loadOlder() 委托原 session face（新旧版都存在），locate 逻辑零改动。
    function chatSessionOf(ctx, sessionId) {
      var binding = null
      var session = null
      try {
        binding = ctx && ctx.sessions && typeof ctx.sessions.binding === 'function'
          ? ctx.sessions.binding(sessionId)
          : null
      } catch (err) { binding = null }
      session = binding !== null && binding !== undefined ? binding.session : null

      // 新通道：uiConversation.binding(sessionId).target('chat')。
      var modern = null
      if (ctx !== null && ctx !== undefined && typeof ctx.get === 'function') {
        try {
          var ui = ctx.get('uiConversation')
          if (ui !== null && ui !== undefined && typeof ui.binding === 'function') {
            var conv = ui.binding(sessionId)
            if (conv !== null && conv !== undefined && typeof conv.target === 'function') {
              var target = conv.target('chat')
              if (target !== null && target !== undefined && typeof target.getSnapshot === 'function') {
                modern = target
              }
            }
          }
        } catch (err) { modern = null }
      }

      if (modern === null && session === null) return null
      return {
        loadOlder: function () {
          if (session !== null && session !== undefined && typeof session.loadOlder === 'function') {
            try { return Promise.resolve(session.loadOlder()) } catch (err) { return Promise.reject(err) }
          }
          return Promise.resolve()
        },
        getSnapshot: function () {
          if (modern !== null) {
            try {
              var chat = modern.getSnapshot()
              if (chat !== null && chat !== undefined) return { chat: chat }
            } catch (err) { /* 回退旧通道 */ }
          }
          if (session !== null && session !== undefined && typeof session.getSnapshot === 'function') {
            try { return session.getSnapshot() } catch (err) { return null }
          }
          return null
        },
      }
    }

    // ── 定位前提：Chat 视图必须在 DOM 中 ─────────────────────────────────
    // DSH 0.2 的对话有「对话 / 轨迹」等多视图（[data-conversation-tabs] 下的
    // [role="tab"]）。停在「轨迹」等视图时 Chat 不渲染（没有任何
    // [data-chat-node-key] 行），此时定位只能失败（控制台 Unable to locate）。
    // 视图切换没有 client 服务 API（selectView 在会话内部 store，只交给视图
    // 组件），因此这里点击视图 tab 切回 Chat：先按已知标签（对话/Chat/聊天）
    // 找，找不到再依次尝试其它 tab；成功即停，全部失败时恢复原 tab。
    var CHAT_VIEW_LABELS = ['对话', 'Chat', '聊天', 'Conversation']

    function chatTabsOf(strip) {
      var tabs = strip !== null && strip !== undefined && typeof strip.querySelectorAll === 'function'
        ? strip.querySelectorAll('[role="tab"]')
        : []
      var preferred = []
      var others = []
      var active = null
      for (var i = 0; i < tabs.length; i++) {
        var tab = tabs[i]
        var label = (tab.textContent || '').trim()
        var selected = typeof tab.getAttribute === 'function' && tab.getAttribute('aria-selected') === 'true'
        if (selected) active = { tab: tab, label: label }
        if (CHAT_VIEW_LABELS.indexOf(label) >= 0) preferred.push(tab)
        else others.push(tab)
      }
      return { preferred: preferred, others: others, active: active }
    }

    async function ensureChatView() {
      if (typeof document === 'undefined' || !document) return false
      if (document.querySelector('[data-chat-node-key]') !== null) return true
      var strip = document.querySelector('[data-conversation-tabs]')
      if (strip === null) return false
      var info = chatTabsOf(strip)
      // 已经在 Chat 视图（只是当前会话还没有可渲染的消息行）：不切视图
      if (info.active !== null && CHAT_VIEW_LABELS.indexOf(info.active.label) >= 0) return false
      var order = info.preferred.concat(info.others)
      for (var i = 0; i < order.length; i++) {
        var tab = order[i]
        if (info.active !== null && tab === info.active.tab) continue
        try { tab.click() } catch (e) { continue }
        await nextFrame()
        await nextFrame()
        if (document.querySelector('[data-chat-node-key]') !== null) return true
      }
      if (info.active !== null) {
        try { info.active.tab.click() } catch (e) { /* 恢复失败忽略 */ }
      }
      return false
    }

    // 完整定位：目标在窗口内直接滚动；否则循环 loadOlder() 向前翻历史窗口，
    // 直到目标出现、窗口不再前移（到底）或翻页超限。返回是否定位成功。
    async function locateFromSession(session, seq) {
      if (session === null || session === undefined || typeof session.getSnapshot !== 'function') return false
      var found = findNodeBySeq(session.getSnapshot(), seq)
      if (found !== null) {
        // 数据层已命中；等一帧确保对应 DOM 行已渲染再滚动
        await nextFrame()
        return scrollToNode(found)
      }
      if (typeof session.loadOlder !== 'function') return false
      var rounds = 0
      var lastMin = minAnchorSeq(session.getSnapshot())
      while (rounds < LOCATE_MAX_PAGES) {
        try {
          await session.loadOlder()
        } catch (e) {
          console.error('[dsh-conversation-flow] loadOlder failed: ' + String(e && e.message ? e.message : e))
          return false
        }
        rounds += 1
        // 让出一帧：等 React 完成本页 prepend 的 DOM 渲染再继续（翻页平滑，不卡主线程）
        await nextFrame()
        var snapshot = session.getSnapshot()
        var candidate = findNodeBySeq(snapshot, seq)
        if (candidate !== null) return scrollToNode(candidate)
        var nextMin = minAnchorSeq(snapshot)
        // 窗口未前移 = 历史到底；窗口起点已越过目标仍未找到 = 目标不可定位
        if (nextMin === null || nextMin === lastMin || nextMin <= seq) return false
        lastMin = nextMin
      }
      return false
    }

    // ── Phase 6 修复：打开文件夹通道（DSH v0.1.2 起 workspaces.openPath 被删）──
    // DSH client 服务 ctx.workspaces.openPath 已在 2026-08 的 client refactor
    // （dsh-v0.1.2-alpha.1，workspaces 迁移进 api/workspace-controller）中删除；
    // 官方当前用 ctx.remote.session（gateway 生成的 Remote namespace）的
    // canOpenWorkspacePath()/openWorkspacePath({ path }) 打开本地路径。
    // 插件用 ctx.get(name) 安全读取（cordis：不要求 inject 声明，未提供时返回
    // undefined——静态 inject 缺失服务会让整个 fiber 挂起，绝不可加），
    // 解析顺序：ctx.get('remote.session') → ctx.get('remote').session →
    // 旧版 ctx.workspaces.openPath 兜底。返回 Promise（成功 resolve / 失败
    // reject(new Error(可读信息))），调用方统一 .catch(console.error)。
    function sessionRemoteOf(ctx) {
      if (ctx === null || ctx === undefined) return null
      if (typeof ctx.get !== 'function') return null
      var ns = null
      try {
        ns = ctx.get('remote.session')
        if (ns !== null && ns !== undefined) return ns
      } catch (e) { ns = null }   // 无该服务 / 读取失败 → 继续探测
      try {
        var remote = ctx.get('remote')
        if (remote !== null && remote !== undefined
          && remote.session !== null && remote.session !== undefined) {
          return remote.session
        }
      } catch (e) { /* 忽略 */ }
      return null
    }

    // canOpenWorkspacePath 的返回值统一为"是否可用"布尔（兼容 bool 与
    // { ok, value } 信封两种形态）。
    function capabilityAvailable(cap) {
      if (cap !== null && cap !== undefined && typeof cap === 'object') {
        if (cap.ok === false) return false
        if (cap.value !== undefined) return !!cap.value
        return true
      }
      return !!cap
    }

    // openWorkspacePath 信封（成功 { ok:true, value:{opened:true} }；失败
    // { ok:false, error:{ code, message } }）→ 成功 resolve / 失败 throw。
    function unwrapOpened(res) {
      if (res === null || res === undefined) return
      if (typeof res === 'object') {
        if (res.ok === true || (res.value !== null && res.value !== undefined && res.value.opened === true)) return
        if (res.ok === false || res.error !== undefined && res.error !== null) {
          var why = res.error && (res.error.message || res.error.code) ? (res.error.message || res.error.code) : 'unknown'
          throw new Error('path open failed: ' + why)
        }
        return   // 未知信封但无错误 → 视为成功（向前兼容）
      }
      return
    }

    // 统一打开会话文件夹（folder 已由 host locate 端点返回）。
    function openFolderNative(ctx, folder) {
      var session = sessionRemoteOf(ctx)
      if (session !== null && session !== undefined) {
        var openFn = typeof session.openWorkspacePath === 'function' ? session.openWorkspacePath : null
        var probeFn = typeof session.canOpenWorkspacePath === 'function' ? session.canOpenWorkspacePath : null
        if (probeFn !== null || openFn !== null) {
          var probe = probeFn !== null
            ? Promise.resolve(probeFn())
            : Promise.resolve({ ok: true, value: true })
          return probe.then(function (cap) {
            if (!capabilityAvailable(cap)) {
              throw new Error('当前环境无法打开本地文件夹（canOpenWorkspacePath=false）')
            }
            if (openFn === null) {
              throw new Error('remote.session.openWorkspacePath 缺失')
            }
            return Promise.resolve(openFn({ path: folder })).then(
              function (res) { unwrapOpened(res) },
              function (err) {
                throw new Error('path open failed: ' + String(err && err.message ? err.message : err))
              },
            )
          })
        }
      }
      // 旧版 DSH（≤ v0.1.1 等）：ctx.workspaces.openPath(folder)（2026-08 已删，仅兜底）。
      var ws = ctx && ctx.workspaces && typeof ctx.workspaces.openPath === 'function' ? ctx.workspaces : null
      if (ws !== null) {
        try {
          return Promise.resolve(ws.openPath(folder)).then(function () { return undefined })
        } catch (err) {
          return Promise.reject(new Error('path open failed: ' + String(err && err.message ? err.message : err)))
        }
      }
      return Promise.reject(new Error('打开文件夹通道不可用（remote.session.openWorkspacePath / workspaces.openPath 均缺失）'))
    }

    // ── 会话导航兼容：当前会话识别 + Session 切换（DSH ≥ v0.2）────────────
    // DSH v0.2 起 SessionListState 不再带 current 字段：当前会话由 mainView
    // 保留标记表达（SessionSummary.retainedBy.mainView > 0，官方 ui-agent-preset
    // 同款判定）。旧版 DSH 仍用 listState.current，两者都兼容。
    function currentSessionIdOf(listState) {
      if (listState === null || listState === undefined) return undefined
      if (typeof listState.current === 'string') return listState.current
      var byId = listState.byId
      if (byId === null || byId === undefined || typeof byId !== 'object') return undefined
      var ids = Array.isArray(listState.ids) ? listState.ids : Object.keys(byId)
      for (var i = 0; i < ids.length; i++) {
        var row = byId[ids[i]]
        if (row === null || row === undefined) continue
        var retained = row.retainedBy
        if (retained !== null && retained !== undefined && Number(retained.mainView) > 0) return ids[i]
      }
      return undefined
    }

    // Session 切换（点击 Branch 用）：DSH ≥ v0.2 的导航迁到
    // ctx.uiWorkspace.openSession(id)（ISessions.open 已删除）；旧版回退
    // ctx.sessions.open(id)。两通道都懒解析，不进静态 inject。
    function openSessionNative(ctx, sessionId) {
      var uiWorkspace = null
      try {
        if (ctx !== null && ctx !== undefined && typeof ctx.get === 'function') uiWorkspace = ctx.get('uiWorkspace')
      } catch (err) { uiWorkspace = null }
      if (uiWorkspace !== null && uiWorkspace !== undefined && typeof uiWorkspace.openSession === 'function') {
        uiWorkspace.openSession(sessionId)
        return true
      }
      if (ctx !== null && ctx !== undefined && ctx.sessions && typeof ctx.sessions.open === 'function') {
        ctx.sessions.open(sessionId)
        return true
      }
      return false
    }

    // ── Rail: 右缘竖向按钮 + Hover 索引窗口 + 点击定位 ─────────────────────
    // 数据通道：Client 只拿 current session id（useSessions 标准 prop），
    // 索引数据经 Host 端点；定位映射经 ctx.sessions.binding(id).session 快照。
    function Rail(props, ctx) {
      var useSessions = props && props.useSessions
      var listState = useSessions ? useSessions(function (state) { return state }) : null
      // DSH ≥ v0.2：SessionListState 无 current 字段 → 由 mainView 保留标记推导；
      // 旧版回退 listState.current（见 currentSessionIdOf）。
      var current = currentSessionIdOf(listState)

      var hoverState = React.useState(false)
      var hover = hoverState[0]
      var setHover = hoverState[1]
      var timerRef = React.useRef(null)

      // 索引数据：{ status: idle|loading|ready|error, messages, error }
      var dataState = React.useState({ status: 'idle', messages: null, error: null })
      var data = dataState[0]
      var setData = dataState[1]
      var seqRef = React.useRef(0)   // 竞态保护：旧响应不覆盖新请求
      var hoverRef = React.useRef(false)   // 同一悬停会话只加载一次（防边缘反复触发）
      // Phase 4：当前展开 Branch 的消息 seq（null = 全部收起）
      var expandedState = React.useState(null)
      var expandedSeq = expandedState[0]
      var setExpandedSeq = expandedState[1]
      // Phase 5：重命名编辑态（当前编辑的 branch sessionId / 输入值 / 错误提示）
      var renamingState = React.useState(null)
      var renamingSeq = renamingState[0]
      var setRenamingSeq = renamingState[1]
      var renameInputState = React.useState('')
      var renameInput = renameInputState[0]
      var setRenameInput = renameInputState[1]
      var renameErrorState = React.useState(null)
      var renameError = renameErrorState[0]
      var setRenameError = renameErrorState[1]
      // Phase 5.1：popup 元素引用（打开时滚到最新消息）
      var popRef = React.useRef(null)

      // 把 popup 滚动到底部（最新消息）。数据未渲染完时滚动无效，
      // 由 load() 成功回调在数据落盘后再次调用。
      function scrollToBottom() {
        var popEl = popRef.current
        if (popEl === null || popEl === undefined) return
        try { popEl.scrollTop = popEl.scrollHeight } catch (e) { /* 非 DOM 环境忽略 */ }
      }

      function load() {
        if (current === undefined) {
          setData({ status: 'idle', messages: null, error: null })
          return
        }
        var my = ++seqRef.current
        // 已有数据时静默刷新：不切"加载中…"，窗口继续显示旧数据直到新数据到达，
        // 避免每次打开/边缘进出都闪"加载中…"。
        var silent = data.status === 'ready' && Array.isArray(data.messages)
        if (!silent) setData({ status: 'loading', messages: null, error: null })
        fetch('/better-interface/session?sessionId=' + encodeURIComponent(current))
          .then(function (res) { return res.json().then(function (json) { return { ok: res.ok, status: res.status, json: json } }) })
          .then(function (result) {
            if (my !== seqRef.current) return
            if (result.ok && result.json !== null && typeof result.json === 'object' && Array.isArray(result.json.messages)) {
              if (result.json.branchAvailable === false) {
                // Branch 谱系不可用：索引照常，仅提示降级（Phase 4 容错）
                console.warn('[dsh-conversation-flow] Unable to resolve branches (lineage unavailable)')
              }
              setData({ status: 'ready', messages: result.json.messages, error: null })
              // Phase 5.1：首次/切换加载完成 → 等一帧渲染后滚到最新消息（静默刷新不打断用户位置）
              if (!silent) nextFrame().then(function () { scrollToBottom() })
            } else if (result.status === 404) {
              // 找不到 Session → 视作暂无对话数据
              setData({ status: 'idle', messages: null, error: null })
            } else {
              var msg = (result.json && result.json.error) || ('HTTP ' + result.status)
              console.error('[dsh-better-interface] 索引读取失败: ' + msg)
              if (!silent) setData({ status: 'error', messages: null, error: msg })
            }
          })
          .catch(function (e) {
            if (my !== seqRef.current) return
            var msg = String(e && e.message ? e.message : e)
            console.error('[dsh-better-interface] 索引读取失败: ' + msg)
            if (!silent) setData({ status: 'error', messages: null, error: msg })
          })
      }

      // Phase 2.1：current 变化（含首次挂载）读取一次；不轮询
      React.useEffect(function () {
        load()
        return function () { if (timerRef.current !== null) clearTimeout(timerRef.current) }
      }, [current])

      function openPop() {
        if (timerRef.current !== null) { clearTimeout(timerRef.current); timerRef.current = null }
        // 只在悬停会话开始时加载一次；rail↔窗口间移动不再反复触发加载
        var firstOpen = !hoverRef.current
        if (firstOpen) load()
        hoverRef.current = true
        setHover(true)
        // Phase 5.1：每次重新打开定位到最新消息（底部）——正在编辑时不动
        if (firstOpen && renamingSeq === null) scrollToBottom()
      }
      function armClose() {
        if (timerRef.current !== null) { clearTimeout(timerRef.current); timerRef.current = null }
        // Phase 5.1：编辑态锁定——输入法候选窗/鼠标移出窗口期间不关闭悬浮窗
        if (renamingSeq !== null) return
        timerRef.current = setTimeout(function () {
          hoverRef.current = false
          setHover(false)
        }, HOVER_GRACE_MS)
      }

      // Phase 3：点击索引项 → 定位对应 Chat 消息（无高亮/动画/弹窗）。
      function handleLocate(seq) {
        if (current === undefined || current === null) {
          console.error('[dsh-conversation-flow] Unable to locate message: seq=' + seq)
          return
        }
        // 取数适配：DSH ≥ v0.1.2 走 ctx.uiConversation.binding().target('chat')
        // （SessionSnapshot 不再含 chat 节点），旧版回退 binding().session。
        var chat = null
        try { chat = chatSessionOf(ctx, current) } catch (e) { chat = null }
        if (chat === null) {
          console.error('[dsh-conversation-flow] Unable to locate message: seq=' + seq)
          return
        }
        // 若对话停在「轨迹」等视图，先切回 Chat（否则没有行可滚动）
        ensureChatView().then(function () {
          return locateFromSession(chat, seq)
        }).then(function (located) {
          if (!located) console.error('[dsh-conversation-flow] Unable to locate message: seq=' + seq)
        })
      }

      // Phase 4：展开/收起某条消息下的 Branch 列表（无 Branch 时点击无效果）。
      function toggleBranches(seq, hasBranches) {
        if (!hasBranches) return
        setExpandedSeq(expandedSeq === seq ? null : seq)
      }
      // Phase 4：点击 Branch → 用 DSH 原生机制打开对应 Session（Chat 切换）：
      // DSH ≥ v0.2 → ctx.uiWorkspace.openSession(id)；旧版 → ctx.sessions.open(id)。
      function openBranch(sessionId) {
        if (sessionId === undefined || sessionId === null) return
        try {
          if (!openSessionNative(ctx, sessionId)) {
            console.error('[dsh-conversation-flow] Unable to resolve branches: session open unavailable')
          }
        } catch (e) {
          console.error('[dsh-conversation-flow] open branch session failed: ' + String(e && e.message ? e.message : e))
        }
      }

      // Phase 5：进入某 Branch 的行内重命名编辑态（✎ → 输入框 + ✓/取消）。
      function startRename(branch) {
        if (branch === null || branch === undefined) return
        // 进入编辑态前清掉任何挂起的关闭计时器（编辑态期间窗口绝不自动关闭）
        if (timerRef.current !== null) { clearTimeout(timerRef.current); timerRef.current = null }
        setRenamingSeq(branch.sessionId)
        setRenameInput(branch.text)
        setRenameError(null)
      }
      // 取消编辑：丢弃输入，退出编辑态。
      function cancelRename() {
        setRenamingSeq(null)
        setRenameInput('')
        setRenameError(null)
      }
      // 提交改名：POST host 端点 → 成功退出编辑态并刷新索引（Branch 显示新名称）。
      function submitRename(branch) {
        if (branch === null || branch === undefined) return
        var text = renameInput === null || renameInput === undefined ? '' : String(renameInput)
        if (text.trim() === '') {
          setRenameError('名称不能为空')
          return
        }
        fetch('/better-interface/rename', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: branch.sessionId, title: text }),
        })
          .then(function (res) { return res.json().then(function (json) { return { ok: res.ok, status: res.status, json: json } }) })
          .then(function (result) {
            if (result.ok && result.json !== null && result.json.ok) {
              setRenamingSeq(null)
              setRenameInput('')
              setRenameError(null)
              load()   // 静默刷新索引 → Branch 显示新名称
              // 侧栏标题可能已变化（改名后匹配失效）→ 通知侧栏重扫。
              if (typeof sidebarHideNotify === 'function') sidebarHideNotify()
            } else {
              var msg = (result.json && result.json.error) || ('HTTP ' + result.status)
              setRenameError(msg)
            }
          })
          .catch(function (e) {
            setRenameError(String(e && e.message ? e.message : '重命名失败'))
          })
      }

      // Phase 6：打开 Session 所在文件夹。
      // host 端点返回 locate() 路径（只读定位，不 materialize）；client 经
      // openFolderNative() 打开资源管理器——DSH ≥ v0.1.2 走官方
      // ctx.remote.session.openWorkspacePath，旧版回退 ctx.workspaces.openPath。
      // 删除动作由用户在文件系统手动完成。
      function openFolder(sessionId) {
        if (sessionId === undefined || sessionId === null) return
        fetch('/better-interface/session-location?sessionId=' + encodeURIComponent(sessionId))
          .then(function (res) { return res.json().then(function (json) { return { ok: res.ok, status: res.status, json: json } }) })
          .then(function (result) {
            if (result.ok && result.json !== null && typeof result.json.folder === 'string') {
              openFolderNative(ctx, result.json.folder).catch(function (e) {
                console.error('[dsh-better-interface] 打开文件夹失败: ' + String(e && e.message ? e.message : e))
              })
            } else {
              var msg = (result.json && result.json.error) || ('HTTP ' + result.status)
              console.error('[dsh-better-interface] 打开文件夹失败: ' + msg)
            }
          })
          .catch(function (e) {
            console.error('[dsh-better-interface] 打开文件夹失败: ' + String(e && e.message ? e.message : e))
          })
      }

      // 三个圆圈视觉标识：直接作为按钮（flex column）的子项
      var dots = [0, 1, 2].map(function (index) {
        return React.createElement('span', { key: index, className: 'sbi-dot' })
      })

      // 索引窗口内容：正序纯文本摘要，不显示 seq / JSON / 事件结构
      var body
      if (current === undefined || data.status === 'idle') {
        body = React.createElement('div', { className: 'sbi-hint' }, '暂无对话数据')
      } else if (data.status === 'loading') {
        body = React.createElement('div', { className: 'sbi-hint' }, '加载中…')
      } else if (data.status === 'error') {
        // 技术错误已在 Console 输出；UI 保持轻量提示
        body = React.createElement('div', { className: 'sbi-hint' }, '暂无对话数据')
      } else if (data.messages.length === 0) {
        body = React.createElement('div', { className: 'sbi-hint' }, '暂无用户消息')
      } else {
        body = data.messages.map(function (message) {
          var branches = Array.isArray(message.branches) ? message.branches : []
          var hasBranches = branches.length > 0
          var expanded = expandedSeq === message.seq
          var item = React.createElement('div', {
            key: message.seq,
            className: 'sbi-item',
            title: message.text,
            onClick: function () { handleLocate(message.seq) },
          },
            React.createElement('div', { className: 'sbi-item-text' }, message.text),
            // 展开按钮：点击只切换 Branch 列表，不触发消息跳转（stopPropagation）
            React.createElement('button', {
              type: 'button',
              className: 'sbi-branch-toggle' + (hasBranches ? ' sbi-branch-toggle-on' : ''),
              'aria-label': hasBranches ? '展开从这里创建的分支' : '无分支',
              title: hasBranches ? '展开从这里创建的分支' : '无分支',
              onClick: function (e) {
                if (e && typeof e.stopPropagation === 'function') e.stopPropagation()
                toggleBranches(message.seq, hasBranches)
              },
            }, hasBranches ? '●' : '○'),
          )
          var rows = [item]
          if (expanded && hasBranches) {
            rows.push(React.createElement('div', {
              key: 'branches-' + message.seq,
              className: 'sbi-branch-list',
            },
              branches.map(function (branch) {
                var isRenaming = renamingSeq === branch.sessionId
                // 编辑态：行内输入框 + ✓ 保存 + ✕ 取消（+ 错误提示）；
                // 非编辑态：文本（点击切换）+ hover 显示 ✎ 重命名。
                // branch-item 用 div 承载（button 内不能嵌套 button）。
                var branchContent = isRenaming
                  ? [
                    React.createElement('span', { key: 'mark', className: 'sbi-branch-mark' }, '└'),
                    React.createElement('div', { key: 'edit', className: 'sbi-branch-edit' },
                      React.createElement('input', {
                        type: 'text',
                        className: 'sbi-branch-input',
                        value: renameInput,
                        placeholder: '输入新名称',
                        onClick: function (e) {
                          if (e && typeof e.stopPropagation === 'function') e.stopPropagation()
                        },
                        onChange: function (e) { setRenameInput(e && e.target ? e.target.value : '') },
                        onKeyDown: function (e) {
                          if (e && (e.key === 'Enter' || e.keyCode === 13)) {
                            if (typeof e.stopPropagation === 'function') e.stopPropagation()
                            submitRename(branch)
                          }
                        },
                      }),
                      React.createElement('button', {
                        type: 'button',
                        className: 'sbi-branch-save',
                        title: '保存',
                        'aria-label': '保存重命名',
                        onClick: function (e) {
                          if (e && typeof e.stopPropagation === 'function') e.stopPropagation()
                          submitRename(branch)
                        },
                      }, '✓'),
                      React.createElement('button', {
                        type: 'button',
                        className: 'sbi-branch-cancel',
                        title: '取消',
                        'aria-label': '取消重命名',
                        onClick: function (e) {
                          if (e && typeof e.stopPropagation === 'function') e.stopPropagation()
                          cancelRename()
                        },
                      }, '✕'),
                      renameError === null ? null : React.createElement('div', { className: 'sbi-branch-error' }, renameError),
                    ),
                  ]
                  : [
                    React.createElement('span', { key: 'mark', className: 'sbi-branch-mark' }, '└'),
                    React.createElement('span', { key: 'text', className: 'sbi-branch-text' }, branch.text),
                    React.createElement('button', {
                      key: 'rename',
                      type: 'button',
                      className: 'sbi-branch-rename',
                      title: '重命名',
                      'aria-label': '重命名 ' + branch.text,
                      onClick: function (e) {
                        if (e && typeof e.stopPropagation === 'function') e.stopPropagation()
                        startRename(branch)
                      },
                    }, '✎'),
                    React.createElement('button', {
                      key: 'folder',
                      type: 'button',
                      className: 'sbi-branch-folder',
                      title: '打开所在文件夹',
                      'aria-label': '打开 ' + branch.text + ' 所在文件夹',
                      onClick: function (e) {
                        if (e && typeof e.stopPropagation === 'function') e.stopPropagation()
                        openFolder(branch.sessionId)
                      },
                    }, '📂'),
                  ]
                return React.createElement('div', {
                  key: branch.sessionId,
                  className: 'sbi-branch-item',
                  title: branch.text,
                  onClick: function (e) {
                    // 编辑态点击不触发切换
                    if (isRenaming) {
                      if (e && typeof e.stopPropagation === 'function') e.stopPropagation()
                      return
                    }
                    if (e && typeof e.stopPropagation === 'function') e.stopPropagation()
                    openBranch(branch.sessionId)
                  },
                }, branchContent)
              }),
            ))
          }
          return rows
        })
        body = body.flat()
      }

      var pop = React.createElement('div', {
        className: 'sbi-pop',
        ref: popRef,
        onMouseEnter: openPop,
        onMouseLeave: armClose,
      },
        React.createElement('div', { className: 'sbi-pop-head' },
          React.createElement('span', { key: 'title', className: 'sbi-pop-head-title' }, '对话索引'),
          React.createElement('button', {
            key: 'folder',
            type: 'button',
            className: 'sbi-head-folder',
            title: '打开当前会话所在文件夹',
            'aria-label': '打开当前会话所在文件夹',
            onClick: function (e) {
              if (e && typeof e.stopPropagation === 'function') e.stopPropagation()
              openFolder(current)
            },
          }, '📂'),
        ),
        body,
      )

      // popup 常驻 DOM；hover 只切换 root 上的 .sbi-hover 类（opacity 显隐）。
      // 绝不按 hover 条件插入/移除 popup 元素——那会让首帧出现在错误位置。
      return React.createElement('div', { 'data-plugin': PLUGIN_ID, className: 'sbi-root' + (hover ? ' sbi-hover' : '') },
        React.createElement('button', {
          type: 'button',
          className: 'sbi-rail',
          'aria-label': '对话索引',
          title: '对话索引（悬停查看）',
          onMouseEnter: openPop,
          onMouseLeave: armClose,
        }, dots),
        pop,
      )
    }

    // ── Phase 6：设置面板内管理界面（settings.section）────────────────────
    // 会话状态管理：列表 + 过滤（全部/隐藏/归档/非活跃）+ 📂 打开文件夹 +
    // 删除只适用于已归档的会话。
    // 共享同一组件。
    var MANAGE_STATE_LABEL = { active: '活跃', hidden: '已隐藏', archived: '已归档' }

    function BetterInterfaceSection(props) {
      var openPath = props && typeof props.openPath === 'function' ? props.openPath : null
      // settings.section 标准 props：useSessions（会话列表，含 displayTitle）、
      // useWorkspaces（工作区列表，含 title + sessionIds）——与侧栏同源。
      var useSessions = props && typeof props.useSessions === 'function' ? props.useSessions : null
      var useWorkspaces = props && typeof props.useWorkspaces === 'function' ? props.useWorkspaces : null
      var listState = React.useState({ status: 'loading', sessions: null, error: null })
      var list = listState[0]
      var setList = listState[1]
      var filterState = React.useState('all')
      var filter = filterState[0]
      var setFilter = filterState[1]
      // 折叠的分组集合（默认空 = 全展开）。
      var collapsedState = React.useState({})
      var collapsedGroups = collapsedState[0]
      var setCollapsedGroups = collapsedState[1]
      var deleteState = React.useState({ pending: null, error: null })
      var deletion = deleteState[0]
      var setDeletion = deleteState[1]
      var deleteInFlight = React.useRef(false)

      // 会话名称（displayTitle）与工作区归属（workspace.title）映射。
      var titleById = {}
      var workspaceBySession = {}
      var workspacesFeed = null
      if (useSessions !== null) {
        try {
          var sessionsFeed = useSessions(function (s) { return s })
          if (sessionsFeed !== null && sessionsFeed !== undefined && sessionsFeed.byId) {
            for (var sidKey in sessionsFeed.byId) {
              var entry = sessionsFeed.byId[sidKey]
              if (entry && typeof entry.displayTitle === 'string') titleById[sidKey] = entry.displayTitle
            }
          }
        } catch (e) { /* 标准数据不可用时降级显示 id */ }
      }
      if (useWorkspaces !== null) {
        try {
          workspacesFeed = useWorkspaces(function (s) { return s })
          if (workspacesFeed !== null && workspacesFeed !== undefined && Array.isArray(workspacesFeed.items)) {
            for (var wIdx = 0; wIdx < workspacesFeed.items.length; wIdx++) {
              var wsItem = workspacesFeed.items[wIdx]
              var wsSessions = wsItem && wsItem.sessionIds
              if (Array.isArray(wsSessions)) {
                for (var sIdx = 0; sIdx < wsSessions.length; sIdx++) {
                  workspaceBySession[wsSessions[sIdx]] = wsItem.title || wsItem.path || ''
                }
              }
            }
          }
        } catch (e) { /* 忽略 */ }
      }

      function loadManage() {
        return fetch('/better-interface/manage-sessions')
          .then(function (res) { return res.json().then(function (json) { return { ok: res.ok, status: res.status, json: json } }) })
          .then(function (result) {
            if (result.ok && result.json !== null && Array.isArray(result.json.sessions)) {
              setList({ status: 'ready', sessions: result.json.sessions, error: null })
            } else {
              var msg = (result.json && result.json.error) || ('HTTP ' + result.status)
              console.error('[dsh-better-interface] 管理列表读取失败: ' + msg)
              setList({ status: 'error', sessions: null, error: msg })
            }
          })
          .catch(function (e) {
            console.error('[dsh-better-interface] 管理列表读取失败: ' + String(e && e.message ? e.message : e))
            setList({ status: 'error', sessions: null, error: String(e && e.message ? e.message : e) })
          })
      }
      React.useEffect(function () { loadManage() }, [])

      async function deleteConversation(sessionId, title) {
        if (deleteInFlight.current || !window.confirm('将会话「' + title + '」的记录移到本地回收目录？')) return
        deleteInFlight.current = true
        setDeletion({ pending: sessionId, error: null })
        try {
          var result = await fetch('/better-interface/session-delete?sessionId=' + encodeURIComponent(sessionId), { method: 'DELETE' })
          if (!result.ok) {
            var body = await result.json().catch(function () { return null })
            throw new Error((body && body.error) || ('HTTP ' + result.status))
          }
          await loadManage()
          if (typeof sidebarHideNotify === 'function') sidebarHideNotify()
          setDeletion({ pending: null, error: null })
        } catch (error) {
          setDeletion({ pending: null, error: '删除失败：' + String(error.message || error) })
        } finally {
          deleteInFlight.current = false
        }
      }

      function changeState(sessionId, state) {
        fetch('/better-interface/session-state', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: sessionId, state: state }),
        })
          .then(function (res) { return res.json().then(function (json) { return { ok: res.ok, status: res.status, json: json } }) })
          .then(function (result) {
            if (result.ok && result.json !== null && result.json.ok) {
              loadManage()
              // 侧栏 DOM 隐藏联动：hidden → 隐藏侧栏行，恢复 → 取消隐藏。
              if (typeof sidebarHideNotify === 'function') sidebarHideNotify()
            } else {
              console.error('[dsh-better-interface] 状态切换失败: ' + ((result.json && result.json.error) || ('HTTP ' + result.status)))
            }
          })
          .catch(function (e) {
            console.error('[dsh-better-interface] 状态切换失败: ' + String(e && e.message ? e.message : e))
          })
      }

      function openFolderOf(sessionId) {
        fetch('/better-interface/session-location?sessionId=' + encodeURIComponent(sessionId))
          .then(function (res) { return res.json().then(function (json) { return { ok: res.ok, status: res.status, json: json } }) })
          .then(function (result) {
            if (result.ok && result.json !== null && typeof result.json.folder === 'string') {
              if (openPath === null) {
                console.error('[dsh-better-interface] 打开文件夹不可用: 打开通道未注入')
                return
              }
              openPath(result.json.folder).catch(function (e) {
                console.error('[dsh-better-interface] 打开文件夹失败: ' + String(e && e.message ? e.message : e))
              })
            } else {
              console.error('[dsh-better-interface] 打开文件夹失败: ' + ((result.json && result.json.error) || ('HTTP ' + result.status)))
            }
          })
          .catch(function (e) {
            console.error('[dsh-better-interface] 打开文件夹失败: ' + String(e && e.message ? e.message : e))
          })
      }

      function filterBtn(key, text) {
        return React.createElement('button', {
          key: key,
          type: 'button',
          className: 'sbi-manage-filter' + (filter === key ? ' sbi-manage-filter-on' : ''),
          onClick: function () { setFilter(key) },
        }, text)
      }

      var sessions = (list.status === 'ready' && Array.isArray(list.sessions)) ? list.sessions : null
      var visible = null
      if (sessions !== null) {
        visible = sessions
        if (filter === 'hidden') visible = sessions.filter(function (s) { return s.state === 'hidden' })
        else if (filter === 'archived') visible = sessions.filter(function (s) { return s.state === 'archived' })
        else if (filter === 'non-active') visible = sessions.filter(function (s) { return s.state !== 'active' })
      }

      // 单个会话行。
      function renderRow(s) {
        var title = titleById[s.sessionId] || s.sessionId
        var label = MANAGE_STATE_LABEL[s.state] || s.state
        if (s.nativeArchived) label = '已归档（原生）'
        var actions = []
        if (s.state === 'active') {
          actions.push(
            React.createElement('button', { key: 'hide', type: 'button', className: 'sbi-manage-act', onClick: function () { changeState(s.sessionId, 'hidden') } }, '隐藏'),
            React.createElement('button', { key: 'archive', type: 'button', className: 'sbi-manage-act', onClick: function () { changeState(s.sessionId, 'archived') } }, '归档'),
          )
        } else if (!s.nativeArchived) {
          // 插件状态（hidden/archived）可恢复；原生归档（DSH 无 unarchive）不可经插件恢复。
          actions.push(
            React.createElement('button', { key: 'restore', type: 'button', className: 'sbi-manage-act', onClick: function () { changeState(s.sessionId, 'active') } }, '恢复'),
          )
        }
        actions.push(
          React.createElement('button', { key: 'folder', type: 'button', className: 'sbi-manage-act', title: '打开所在文件夹', onClick: function () { openFolderOf(s.sessionId) } }, '📂'),
        )
        if (s.state === 'archived') {
          actions.push(React.createElement('button', {
            key: 'delete',
            type: 'button',
            className: 'sbi-manage-act',
            disabled: s.live || deletion.pending !== null,
            title: s.live ? '会话仍打开，关闭后可删除' : '移到本地回收目录',
            'aria-label': '删除会话 ' + title,
            onClick: function () { return deleteConversation(s.sessionId, title) },
          }, deletion.pending === s.sessionId ? '删除中…' : '删除'))
        }
        var wsTitle = workspaceBySession[s.sessionId] || ''
        return React.createElement('div', { key: s.sessionId, className: 'sbi-manage-row' },
          React.createElement('span', { className: 'sbi-manage-state sbi-manage-state-' + s.state }, label),
          React.createElement('span', { className: 'sbi-manage-id' },
            React.createElement('div', { className: 'sbi-manage-name', title: title }, title),
            React.createElement('div', { className: 'sbi-manage-meta' }, s.sessionId + (wsTitle !== '' ? ' · ' + wsTitle : '') + (s.live ? '' : '（未打开）')),
          ),
          React.createElement('span', { className: 'sbi-manage-actions' }, actions),
        )
      }

      // 按工作区分组（useWorkspaces.items + 未归属 → 未分组）。
      // visible 为 null（loading/error）时跳过——body 走提示分支。
      var groups = null
      if (visible !== null && workspacesFeed !== null && Array.isArray(workspacesFeed.items)) {
        groups = []
        var seenIds = {}
        for (var gIdx = 0; gIdx < workspacesFeed.items.length; gIdx++) {
          var gw = workspacesFeed.items[gIdx]
          var gSessionIds = gw && Array.isArray(gw.sessionIds) ? gw.sessionIds : []
          var members = []
          for (var mIdx = 0; mIdx < gSessionIds.length; mIdx++) {
            var mId = gSessionIds[mIdx]
            for (var vIdx = 0; vIdx < visible.length; vIdx++) {
              if (visible[vIdx].sessionId === mId) { members.push(visible[vIdx]); seenIds[mId] = true; break }
            }
          }
          groups.push({
            key: gw.workspaceId || gw.title || 'ws-' + gIdx,
            title: gw.title || gw.path || '工作区',
            members: members,
          })
        }
        var stray = visible.filter(function (s) { return !seenIds[s.sessionId] })
        if (stray.length > 0) {
          groups.push({ key: '__ungrouped', title: '未分组', members: stray })
        }
      }

      var body
      if (list.status === 'loading' || list.status === 'idle') {
        body = React.createElement('div', { className: 'sbi-manage-hint' }, '加载中…')
      } else if (list.status === 'error' || visible === null) {
        body = React.createElement('div', { className: 'sbi-manage-hint' }, '会话列表读取失败（见 Console）')
      } else if (visible.length === 0) {
        body = React.createElement('div', { className: 'sbi-manage-hint' }, '暂无会话')
      } else {
        var renderGroups = groups !== null ? groups : [{ key: '__all', title: '全部会话', members: visible }]
        body = renderGroups.map(function (group) {
          var collapsed = collapsedGroups[group.key] === true
          var head = React.createElement('button', {
            key: 'head',
            type: 'button',
            className: 'sbi-manage-group-head',
            onClick: function () {
              setCollapsedGroups(function (prev) {
                var next = {}
                for (var k in prev) next[k] = prev[k]
                next[group.key] = !(prev[group.key] === true)
                return next
              })
            },
          },
            React.createElement('span', { className: 'sbi-manage-group-caret' }, collapsed ? '▸' : '▾'),
            React.createElement('span', { className: 'sbi-manage-group-title' }, group.title),
            React.createElement('span', { className: 'sbi-manage-group-count' }, group.members.length),
          )
          var groupBody = collapsed
            ? null
            : React.createElement('div', { key: 'body', className: 'sbi-manage-group-body' }, group.members.map(renderRow))
          return React.createElement('div', { key: group.key, className: 'sbi-manage-group' }, [head, groupBody])
        })
      }

      return React.createElement('div', { 'data-plugin': PLUGIN_ID, className: 'sbi-manage-root' },
        React.createElement('div', { className: 'sbi-manage' },
          React.createElement('div', { className: 'sbi-manage-title' }, 'BetterInterface'),
          React.createElement('div', { className: 'sbi-manage-sub' }, '会话归档并关闭后，可以删除到本地回收目录。'),
          React.createElement('div', { className: 'sbi-manage-filters' },
            filterBtn('all', '全部'),
            filterBtn('hidden', '已隐藏'),
            filterBtn('archived', '已归档'),
            filterBtn('non-active', '非活跃'),
          ),
          React.createElement('div', { className: 'sbi-manage-list' }, body),
          deletion.error === null ? null : React.createElement('div', { role: 'alert', className: 'sbi-manage-hint' }, deletion.error),
        ),
      )
    }

    // ── Phase 6.5：Chat 用户长消息折叠（路径 B）──────────────────────────
    // 保留 DSH 官方渲染器；ChatNodeSeat 行带 data-chat-flow-kind={node.kind}
    // （ChatNodeSeat.tsx:48），用 [data-chat-flow-kind="user"] 精确选中用户消息行
    // （不依赖 key 格式；assistant/工具消息 kind 不同，天然排除）。
    // 判定策略：行高估计（computed lineHeight，'normal' 时 fontSize×1.5）+
    // 放宽预判（≥4 行即尝试）+ 折叠后自检（同一帧内裁剪验证，无闪烁）——
    // 避免行高估计偏差导致 5 行消息漏折叠。
    var FOLD_MAX_LINES = 5
    // 折叠对象 = 人类输入的聊天气泡：普通用户消息（user）与排队/插话的 steering
    // 消息（DSH 0.2 起后者常见；同为 UserStyleBubble、同样样式）。上下文注入
    // （context / turn-trigger）不是人类文本，不折叠。
    var FOLD_ROW_SELECTOR = '[data-chat-flow-kind="user"], [data-chat-flow-kind="steering"]'

    function foldLineHeightOf(el) {
      var lh = 20
      if (typeof getComputedStyle === 'function') {
        try {
          var ls = getComputedStyle(el).lineHeight
          var parsed = parseFloat(ls)
          if (parsed > 0) lh = parsed
          else {
            var fs = parseFloat(getComputedStyle(el).fontSize)
            if (fs > 0) lh = fs * 1.5
          }
        } catch (e) { /* 默认 20 */ }
      }
      return lh
    }

    // 行内定位气泡：含文本 + 非透明背景 + 圆角（MessageItem.module.css .bubble：
    // background var(--dsw-specific-bubble)、border-radius 22px、line-height 24px）。
    // 折叠只作用于气泡——行内 actions/引用等不参与判定，短消息不误折叠，
    // 气泡圆角矩形外观保持。找不到特征时 fallback 最大含文本块。
    function findBubble(row) {
      if (row === null || row === undefined || typeof row.querySelectorAll !== 'function') return null
      var all = row.querySelectorAll('*')
      var best = null
      var bestH = 0
      var fallback = null
      var fallbackH = 0
      for (var i = 0; i < all.length; i++) {
        var el = all[i]
        if (el.textContent === undefined) continue
        if ((el.textContent || '').trim() === '') continue
        if (typeof el.scrollHeight !== 'number') continue
        if (el.scrollHeight > fallbackH) { fallbackH = el.scrollHeight; fallback = el }
        var isBubble = false
        if (typeof getComputedStyle === 'function') {
          try {
            var cs = getComputedStyle(el)
            var bg = cs.backgroundColor
            var radius = parseFloat(cs.borderRadius)
            if (radius > 0 && bg !== undefined && bg !== null && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
              isBubble = true
            }
          } catch (e) { /* 特征读取失败按非气泡处理 */ }
        }
        if (isBubble && el.scrollHeight > bestH) { bestH = el.scrollHeight; best = el }
      }
      return best !== null ? best : fallback
    }

    // 严格判定：文本块内容高度 > N 行。导出供测试。
    function foldNeeded(el, maxLines) {
      if (el === null || el === undefined || typeof el.scrollHeight !== 'number') return false
      return el.scrollHeight > maxLines * foldLineHeightOf(el)
    }

    // 折叠/展开文本块：max-height = N 行 + 上下 padding（避免第 N 行截半）+ class。
    function setFolded(el, folded, maxLines) {
      if (folded) {
        var lh = foldLineHeightOf(el)
        var padTop = 0
        var padBottom = 0
        if (typeof getComputedStyle === 'function') {
          try {
            padTop = parseFloat(getComputedStyle(el).paddingTop) || 0
            padBottom = parseFloat(getComputedStyle(el).paddingBottom) || 0
          } catch (e) { /* 忽略 */ }
        }
        el.style.maxHeight = (maxLines * lh + padTop + padBottom) + 'px'
        el.classList.add('sbi-fold')
      } else {
        el.style.maxHeight = ''
        el.classList.remove('sbi-fold')
      }
    }

    // DOM 集成：扫描用户行 → 定位文本块 → 放宽预判 + 折叠自检 + 注入按钮。
    // 按钮注入到文本块（absolute 相对文本块，CSS 定位左下角）。
    function initUserFold() {
      if (typeof document === 'undefined' || !document.body) return
      if (typeof MutationObserver === 'undefined') return

      var USER_ROW_SELECTOR = FOLD_ROW_SELECTOR
      var foldStats = { rows: 0, folded: 0 }

      function injectBtn(target) {
        if (target.querySelector('.sbi-fold-btn') !== null) return
        // 持久定位祖先：展开后 .sbi-fold 会被移除（其 position:relative 随之消失），
        // 若不加 inline relative，按钮会相对视口跑到界面角落且不跟随滚动。
        target.style.position = 'relative'
        var btn = document.createElement('button')
        btn.type = 'button'
        btn.className = 'sbi-fold-btn'
        btn.textContent = '▲' // 折叠态：向上 = 内容已收起
        btn.title = '展开全文'
        btn.setAttribute('aria-label', '展开全文')
        btn.addEventListener('click', function (e) {
          if (e && typeof e.stopPropagation === 'function') e.stopPropagation()
          var folded = target.classList.contains('sbi-fold')
          setFolded(target, !folded, FOLD_MAX_LINES)
          // 状态指示：折叠态 ▲（内容已收起），展开态 ▼（内容在下方展开）
          btn.textContent = folded ? '▲' : '▼'
          btn.title = folded ? '展开全文' : '收起'
          btn.setAttribute('aria-label', folded ? '展开全文' : '收起')
        })
        target.appendChild(btn)
      }

      function processRow(row) {
        // 已有按钮（折叠或展开状态，用户可控制）→ 跳过。
        // 展开后按钮仍在（textContent=收起），observer 不会把它重新折叠。
        if (row.querySelector('.sbi-fold-btn') !== null) return
        var target = findBubble(row)
        if (target === null) return
        var lh = foldLineHeightOf(target)
        // 放宽预判：文本块达到 (N-1) 行以上才尝试（3 行及以下直接跳过）
        if (target.scrollHeight < (FOLD_MAX_LINES - 1) * lh) return
        // 折叠（同一帧内同步）→ 自检实际裁剪：未裁剪 = 内容未超 → 撤销（无闪烁）
        setFolded(target, true, FOLD_MAX_LINES)
        if (target.scrollHeight <= target.clientHeight) {
          setFolded(target, false, FOLD_MAX_LINES)
          return
        }
        foldStats.folded += 1
        injectBtn(target)
      }

      function scan(root) {
        if (!root || typeof root.querySelectorAll !== 'function') return
        var rows = root.querySelectorAll(USER_ROW_SELECTOR)
        for (var i = 0; i < rows.length; i++) { foldStats.rows += 1; processRow(rows[i]) }
      }
      scan(document)
      if (typeof console !== 'undefined' && console.info) {
        console.info('[dsh-better-interface] fold scan: rows=' + foldStats.rows + ', folded=' + foldStats.folded)
      }

      var observer = new MutationObserver(function (mutations) {
        var rows = new Set()
        for (var m = 0; m < mutations.length; m++) {
          var mut = mutations[m]
          for (var n = 0; n < mut.addedNodes.length; n++) {
            var node = mut.addedNodes[n]
            if (!node || node.nodeType !== 1) continue
            if (typeof node.matches === 'function' && node.matches(USER_ROW_SELECTOR)) rows.add(node)
            else if (typeof node.querySelectorAll === 'function') {
              var inner = node.querySelectorAll(USER_ROW_SELECTOR)
              for (var k = 0; k < inner.length; k++) rows.add(inner[k])
            }
          }
          // 内容更新（同节点变化）：重新判定该行（已折叠的行由 .sbi-fold 检查跳过）
          if (mut.target && mut.target.nodeType === 1) {
            if (typeof mut.target.matches === 'function' && mut.target.matches(USER_ROW_SELECTOR)) rows.add(mut.target)
            else if (typeof mut.target.querySelectorAll === 'function') {
              var inner2 = mut.target.querySelectorAll(USER_ROW_SELECTOR)
              for (var k2 = 0; k2 < inner2.length; k2++) rows.add(inner2[k2])
            }
          }
        }
        rows.forEach(processRow)
      })
      observer.observe(document.body, { childList: true, subtree: true, characterData: true })
    }

    // ── Phase 6.6：侧栏 DOM 隐藏（用户选定方案②）─────────────────────────
    // DSH 官方 API 无 unarchive（workspace 源码注释 "a future unarchive
    // restores its position"）：侧栏显示 = 全量会话 − archivedSessionIds，
    // 插件状态 hidden 只过滤插件视图。为让"隐藏的对话在左侧栏也看不见"且
    // 可恢复：纯 client DOM 注入（不改 Core）——hidden 会话按标题匹配侧栏行
    // （[role="treeitem"]，行内 span 文本 === displayTitle）并 display:none；
    // 恢复（active）时取消。React 重建行会恢复样式 → MutationObserver 持续
    // 兜底（rAF 节流）。
    // 数据源：GET /better-interface/manage-sessions（state==='hidden' 的 id）
    //   + ctx.sessions.list.getSnapshot().byId[sid].displayTitle（与侧栏同源，
    //   SessionRuntime 投影：durable title / 项目 basename / session id 兜底）。
    // 触发：apply 初始化 + 管理界面状态切换/改名成功后 dispatch
    //   'dsh-bi-state-changed' + observer 扫描兜底。
    // 已知限制：标题精确匹配——重名会话会一起隐藏（建议重命名区分）；
    //   workspace 行标题与 hidden 标题相同也会误隐藏（概率极低）。
    var sidebarHideNotify = null

    function titleInRow(row, title) {
      if (row === null || row === undefined || typeof row.querySelectorAll !== 'function') return false
      var spans = row.querySelectorAll('span')
      for (var i = 0; i < spans.length; i++) {
        var t = spans[i] && spans[i].textContent
        if (typeof t === 'string' && t.trim() === title) return true
      }
      return false
    }

    function processSidebarRow(row, titles) {
      var hidden = false
      if (titles !== null && titles !== undefined && Array.isArray(titles)) {
        for (var i = 0; i < titles.length; i++) {
          if (titleInRow(row, titles[i])) { hidden = true; break }
        }
      }
      if (hidden) {
        row.style.display = 'none'
        row.setAttribute('data-sbi-sidebar-hidden', '1')
      } else if (typeof row.getAttribute === 'function' && row.getAttribute('data-sbi-sidebar-hidden') === '1') {
        row.style.display = ''
        row.removeAttribute('data-sbi-sidebar-hidden')
      }
    }

    function initSidebarHide(ctx) {
      if (typeof document === 'undefined' || !document.body) return
      if (typeof MutationObserver === 'undefined') return
      if (typeof fetch !== 'function') return
      var sessionsSvc = ctx && ctx.sessions ? ctx.sessions : null
      var hiddenTitles = null   // null = 未加载（不动任何行）；数组 = 已加载
      var scanPending = false
      var retries = 0

      function notify() {
        if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
          try { window.dispatchEvent(new CustomEvent('dsh-bi-state-changed')) } catch (e) { /* 忽略 */ }
        }
      }
      sidebarHideNotify = notify

      function scanAll() {
        if (hiddenTitles === null) return
        var rows = document.querySelectorAll('[role="treeitem"]')
        for (var i = 0; i < rows.length; i++) processSidebarRow(rows[i], hiddenTitles)
      }

      function loadHidden() {
        fetch('/better-interface/manage-sessions')
          .then(function (res) { return res.json().then(function (json) { return { ok: res.ok, json: json } }) })
          .then(function (result) {
            if (!result.ok || result.json === null || !Array.isArray(result.json.sessions)) {
              hiddenTitles = []   // 拉取失败 → 保守：不隐藏任何行
              return
            }
            var byId = null
            if (sessionsSvc !== null && sessionsSvc.list && typeof sessionsSvc.list.getSnapshot === 'function') {
              try {
                var snap = sessionsSvc.list.getSnapshot()
                byId = snap && snap.byId ? snap.byId : null
              } catch (e) { byId = null }
            }
            var titles = []
            var missing = 0
            for (var i = 0; i < result.json.sessions.length; i++) {
              var s = result.json.sessions[i]
              if (s.state !== 'hidden') continue
              missing += 1
              var summary = byId !== null ? byId[s.sessionId] : undefined
              if (summary && typeof summary.displayTitle === 'string' && summary.displayTitle !== '') {
                titles.push(summary.displayTitle)
                missing -= 1
              }
            }
            hiddenTitles = titles
            scanAll()
            // 标题映射未就绪（sessions 列表还没加载完）→ 延迟重试（上限 5 次）
            if (missing > 0 && retries < 5) {
              retries += 1
              setTimeout(loadHidden, 800)
            }
          })
          .catch(function (e) {
            hiddenTitles = []
            console.error('[dsh-better-interface] 侧栏隐藏数据加载失败: ' + String(e && e.message ? e.message : e))
          })
      }

      function scheduleScan() {
        if (scanPending) return
        scanPending = true
        requestAnimationFrame(function () {
          scanPending = false
          scanAll()
        })
      }

      var observer = new MutationObserver(scheduleScan)
      observer.observe(document.body, { childList: true, subtree: true, characterData: true })

      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('dsh-bi-state-changed', loadHidden)
      }
      loadHidden()
    }

    var inject = ['slots', 'sessions', 'workspaces']

    function apply(ctx) {
      if (typeof console !== 'undefined' && console.info) {
        console.info('[dsh-better-interface] client apply (Phase 4)')
      }
      // Phase 6.5：Chat 用户长消息折叠（DOM 注入，无需 ctx 服务）。
      try { initUserFold() } catch (e) {
        console.error('[dsh-better-interface] 长消息折叠初始化失败: ' + String(e && e.message ? e.message : e))
      }
      // Phase 6.6：侧栏 DOM 隐藏（hidden 会话从左侧栏隐藏，可恢复）。
      try { initSidebarHide(ctx) } catch (e) {
        console.error('[dsh-better-interface] 侧栏隐藏初始化失败: ' + String(e && e.message ? e.message : e))
      }
      ctx.slots.inject('shell.overlay', function () {
        return ctx.slots.register({
          name: 'shell.overlay',
          id: 'better-interface-rail',
          order: 100,
        }, function (props) { return Rail(props, ctx) })
      })
      // Phase 6：设置面板导航（Agent 预设下方一个条目）：
      //   仅注册 BetterInterface（插件入口）——DSH 设置导航的每个条目都是
      //   可点击按钮（shell 按未知 id 自动配齿轮图标），无法做"无图标的纯
      //   提示文字"条目，因此不注册"插件管理"提示项。
      // 📂 打开通道：DSH ≥ v0.1.2 用官方 ctx.remote.session.openWorkspacePath
      // （workspaces.openPath 已被 DSH 删除）；旧版 DSH 回退 ctx.workspaces.openPath。
      // 两通道都在 openFolderNative 内懒解析（ctx.get 安全读取，无静态 inject）。
      function sectionInjected() {
        return {
          openPath: function (folder) {
            return openFolderNative(ctx, folder)
          },
        }
      }
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register({
          name: 'settings.section',
          id: 'better-interface',
          order: 21,
          label: function () { return 'BetterInterface' },
          inject: sectionInjected,
        }, function (props) { return BetterInterfaceSection(props) })
      })
      registerPricePanel(ctx)
    }

    // DeepSeek pricing and balance panel in the sidebar footer.
    function registerPricePanel(ctx) {
      var REFRESH_MS = 30000

      // ── CSS ───────────────────────────────────────────────────────────────────
      // The pills use a base flowing gradient plus two absolutely-positioned
      // pseudo layers of radial colour blobs, each animating on its own diagonal
      // track and duration with 0/50/100% keyframes, so the motion reads as
      // irregular churning rather than a left-right sweep. The pseudo layers sit
      // between the pill background and the text (z-index:-1 inside the pill's
      // stacking context) so the label stays crisp on top.
      var CSS = [
        // Stack every occupant of the footer-action slot vertically so the price
        // row spans the full sidebar width (the shipped Cordis panel claims the
        // whole row otherwise). Inline display:contents is beaten by !important.
        // The anchor is a flex item of `.footerActions` (a flex row): it must
        // stretch to the row's full width (`width:100%`), or its children
        // collapse to content width and the row's right edge falls short of the
        // Settings trigger. In the collapsed rail (the frame carries the literal
        // data-sidebar-collapsed attribute — never a hashed class) the anchor
        // goes back to content width and centers its child instead of stretching.
        '[data-slot="sidebar.footer.action"]{display:flex !important;flex-direction:column;align-items:stretch;width:100%;min-width:0}',
        '[data-sidebar-collapsed] [data-slot="sidebar.footer.action"]{width:auto;align-items:center}',
        // Wrapper provides the positioning context for the floating panel. This
        // element ITSELF carries the data-plugin attribute, so the selector must
        // be `[data-plugin=…].pmo-wrap` (no descendant space) to match — a
        // descendant selector would never apply, leaving the wrap unpositioned
        // and the panel anchored to the app frame (invisible off-screen).
        SCOPE + '.pmo-wrap{position:relative;flex:none;min-width:0;width:calc(100% + 4px);margin:4px -2px}',
        // Row button: geometry + hover chrome mirror the Settings trigger
        // (ui-settings-general SettingsRoot.module.css .trigger / :hover).
        // Grid splits the row 50/50: period pill left, balance right.
        SCOPE + ' .pmo-root{display:grid;grid-template-columns:1fr 1fr;align-items:center;gap:8px;width:100%;height:42px;padding:0 10px 0 8px;box-sizing:border-box;border:none;border-radius:12px;background:transparent;cursor:pointer;font:inherit;color:var(--dsw-alias-label-primary);text-align:left}',
        SCOPE + ' .pmo-root:hover{background:var(--dsw-specific-sidebar-nav-item-hover,rgba(0,0,0,0.07))}',
        SCOPE + ' .pmo-root.pmo-open{background:var(--dsw-specific-sidebar-nav-item-active,rgba(0,0,0,0.11))}',
        // Period pill: rounded capsule, layered flowing gradients. The label
        // span hides in the collapsed rail, leaving a colored dot.
        SCOPE + ' .pmo-pill{position:relative;z-index:0;overflow:hidden;display:inline-flex;align-items:center;justify-content:center;padding:3px 12px;border-radius:999px;font-size:12px;font-weight:600;line-height:20px;white-space:nowrap;min-width:64px;justify-self:center}',
        SCOPE + ' .pmo-pill::before,.pmo-pill::after{content:"";position:absolute;inset:-25%;border-radius:inherit;pointer-events:none;z-index:-1}',
        // Off-peak (谷咕咕): light blue / yellow / light purple.
        SCOPE + ' .pmo-pill.pmo-offpeak{color:#333;background:linear-gradient(120deg,#a8d8ff,#ffe89a,#e0c3ff,#a8d8ff);background-size:320% 320%;animation:pmo-base-a 6s ease-in-out infinite alternate}',
        SCOPE + ' .pmo-pill.pmo-offpeak::before{background-image:radial-gradient(circle at 30% 40%,rgba(168,216,255,0.95),transparent 45%),radial-gradient(circle at 70% 60%,rgba(255,232,154,0.9),transparent 45%);background-size:120% 120%;animation:pmo-blob-a 5.3s ease-in-out infinite alternate}',
        SCOPE + ' .pmo-pill.pmo-offpeak::after{background-image:radial-gradient(circle at 60% 30%,rgba(224,195,255,0.9),transparent 40%),radial-gradient(circle at 20% 80%,rgba(255,216,140,0.85),transparent 40%);background-size:130% 130%;animation:pmo-blob-b 7.6s ease-in-out infinite alternate}',
        // Peak (疯峰峰): light red / orange / light green.
        SCOPE + ' .pmo-pill.pmo-peak{color:#333;background:linear-gradient(120deg,#ffb3b8,#ffc08a,#a9e0b8,#ffb3b8);background-size:320% 320%;animation:pmo-base-b 6.5s ease-in-out infinite alternate}',
        SCOPE + ' .pmo-pill.pmo-peak::before{background-image:radial-gradient(circle at 25% 35%,rgba(255,179,184,0.95),transparent 45%),radial-gradient(circle at 75% 65%,rgba(255,192,138,0.9),transparent 45%);background-size:120% 120%;animation:pmo-blob-c 5.6s ease-in-out infinite alternate}',
        SCOPE + ' .pmo-pill.pmo-peak::after{background-image:radial-gradient(circle at 60% 25%,rgba(169,224,184,0.9),transparent 40%),radial-gradient(circle at 15% 75%,rgba(255,205,160,0.85),transparent 42%);background-size:130% 130%;animation:pmo-blob-d 7.2s ease-in-out infinite alternate}',
        '@keyframes pmo-base-a{from{background-position:0% 50%}to{background-position:100% 50%}}',
        '@keyframes pmo-blob-a{0%{background-position:0% 0%,100% 100%}50%{background-position:80% 20%,10% 60%}100%{background-position:100% 100%,0% 0%}}',
        '@keyframes pmo-blob-b{0%{background-position:100% 0%,0% 100%}50%{background-position:20% 80%,90% 30%}100%{background-position:0% 100%,100% 0%}}',
        '@keyframes pmo-base-b{from{background-position:0% 50%}to{background-position:100% 50%}}',
        '@keyframes pmo-blob-c{0%{background-position:0% 0%,100% 100%}50%{background-position:60% 70%,30% 20%}100%{background-position:100% 100%,0% 0%}}',
        '@keyframes pmo-blob-d{0%{background-position:100% 0%,0% 100%}50%{background-position:30% 90%,80% 10%}100%{background-position:0% 100%,100% 0%}}',
        // Balance: same font size as the Settings label, centered in the right
        // half of the row.
        SCOPE + ' .pmo-balance{justify-self:center;font-size:14px;line-height:22px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
        // Collapsed rail: 36px circle control matching the Settings rail circle,
        // with a colored period dot (the label is hidden).
        SCOPE + '.pmo-wrap.pmo-rail{width:auto;margin:8px 0 10px}',
        SCOPE + ' .pmo-rail .pmo-root{display:flex;justify-content:center;align-items:center;width:36px;height:36px;padding:0;border-radius:50%}',
        SCOPE + ' .pmo-rail .pmo-pill{min-width:0;width:28px;height:28px;padding:0;border-radius:50%}',
        SCOPE + ' .pmo-rail .pmo-label{display:none}',
        // Floating detail panel: opens ABOVE the row (wide mode).
        SCOPE + ' .pmo-pop{position:absolute;bottom:calc(100% + 8px);left:0;right:0;z-index:60;min-width:220px;max-height:min(420px,calc(100vh - 120px));overflow:auto;padding:12px;box-sizing:border-box;border-radius:12px;background:var(--dsw-alias-bg-layer-2,#fff);box-shadow:var(--dsw-shadow-lv2,0 8px 24px rgba(0,0,0,0.16));border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,0.08));color:var(--dsw-alias-label-primary,#222);font-size:12px;line-height:20px}',
        SCOPE + ' .pmo-pop-title{font-weight:600;margin-bottom:6px}',
        SCOPE + ' .pmo-pop-sub{font-weight:600;margin:10px 0 4px;color:var(--dsw-alias-label-secondary,#777)}',
        SCOPE + ' .pmo-pop-model{font-weight:600;margin:6px 0 2px}',
        SCOPE + ' .pmo-pop-balance{font-weight:600}',
        SCOPE + ' .pmo-pop-src{margin-top:8px;font-size:11px;color:var(--dsw-alias-label-tertiary,#999);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        // Last sync time with the official page (and a stale warning when the
        // auto-refresh keeps failing after a page-structure change).
        SCOPE + ' .pmo-pop-sync{margin-top:6px;font-size:11px;color:var(--dsw-alias-label-tertiary,#999)}',
        SCOPE + ' .pmo-pop-warn{margin-top:6px;font-size:11px;font-weight:500;color:#b45309}',
        '@media (prefers-reduced-motion:reduce){' + SCOPE + ' .pmo-pill.pmo-offpeak,' + SCOPE + ' .pmo-pill.pmo-peak,' + SCOPE + ' .pmo-pill.pmo-offpeak::before,' + SCOPE + ' .pmo-pill.pmo-offpeak::after,' + SCOPE + ' .pmo-pill.pmo-peak::before,' + SCOPE + ' .pmo-pill.pmo-peak::after{animation:none}}',
      ].join('')
      var CSS_ID = PLUGIN_ID + '/price-monitor.css'
      if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="' + CSS_ID + '"]') === null) {
        var tag = document.createElement('style')
        tag.dataset.plugin = PLUGIN_ID
        tag.dataset.pluginCss = CSS_ID
        tag.textContent = CSS
        document.head.appendChild(tag)
      }

      function formatWindow(w) {
        return w.startHour + ':' + String(w.startMinute).padStart(2, '0') + '-' +
          w.endHour + ':' + String(w.endMinute).padStart(2, '0')
      }

      // ISO (UTC) instant → Beijing wall time "YYYY-MM-DD HH:mm".
      function formatBeijing(iso) {
        var d = new Date(new Date(iso).getTime() + 8 * 3600 * 1000)
        return d.getUTCFullYear() + '-' +
          String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
          String(d.getUTCDate()).padStart(2, '0') + ' ' +
          String(d.getUTCHours()).padStart(2, '0') + ':' +
          String(d.getUTCMinutes()).padStart(2, '0')
      }

      function PricePanel(props) {
        var wide = !props || props.wide !== false
        var state = React.useState(null)
        var data = state[0]
        var setData = state[1]
        var errorState = React.useState(null)
        var error = errorState[0]
        var setError = errorState[1]
        var openState = React.useState(false)
        var open = openState[0]
        var setOpen = openState[1]

        React.useEffect(function () {
          var alive = true
          async function load() {
            try {
              var res = await fetch('/price-monitor/status')
              var json = await res.json()
              if (alive) {
                setData(json)
                setError(null)
              }
            } catch (e) {
              if (alive) setError(String(e && e.message ? e.message : e))
            }
          }
          load()
          var timer = setInterval(load, REFRESH_MS)
          return function () {
            alive = false
            clearInterval(timer)
          }
        }, [])

        // The Host answers 200 with `{ error }` when it cannot load/parse the
        // pricing page. Without folding that into the failure state the row sat on
        // "加载中…" forever and the real cause stayed invisible.
        var hostError = (data !== null && data.error !== undefined && data.error !== null)
          ? String(data.error)
          : null
        var failure = error !== null ? error : hostError

        var hoverTimer = React.useRef(null)
        var wrapRef = React.useRef(null)

        // Hovering the row opens the panel; a grace timer bridges the gap to the
        // panel so moving the pointer up into it does not close it.
        function onEnter() {
          if (hoverTimer.current !== null) {
            clearTimeout(hoverTimer.current)
            hoverTimer.current = null
          }
          setOpen(true)
        }
        function onLeave() {
          if (hoverTimer.current !== null) clearTimeout(hoverTimer.current)
          hoverTimer.current = setTimeout(function () { setOpen(false) }, 220)
        }

        // Close on outside pointerdown or Escape while the panel is open.
        React.useEffect(function () {
          if (!open) return undefined
          function onPointerDown(e) {
            var el = wrapRef.current
            if (el && !el.contains(e.target)) setOpen(false)
          }
          function onKeyDown(e) {
            if (e.key === 'Escape') setOpen(false)
          }
          document.addEventListener('pointerdown', onPointerDown)
          document.addEventListener('keydown', onKeyDown)
          return function () {
            document.removeEventListener('pointerdown', onPointerDown)
            document.removeEventListener('keydown', onKeyDown)
          }
        }, [open])

        // ── pill (label span is hidden by CSS in the rail, leaving a dot) ───────
        var pill
        if (failure !== null) {
          pill = React.createElement(
            'span',
            { className: 'pmo-pill pmo-peak' },
            React.createElement('span', { className: 'pmo-label' }, '价格不可用'),
          )
        } else if (data === null || data.period === undefined) {
          pill = React.createElement(
            'span',
            { className: 'pmo-pill', style: { background: '#e4e4e7' } },
            React.createElement('span', { className: 'pmo-label' }, '加载中…'),
          )
        } else {
          var cls = data.period === 'peak' ? 'pmo-pill pmo-peak' : 'pmo-pill pmo-offpeak'
          var text = data.period === 'peak' ? '疯峰峰' : '谷咕咕'
          pill = React.createElement(
            'span',
            { className: cls },
            React.createElement('span', { className: 'pmo-label' }, text),
          )
        }

        // ── balance text (shown in the right half when wide) ────────────────────
        var balanceText = null
        if (data !== null) {
          // The Host answers `{ now, error }` when it cannot load or parse the
          // pricing page, so `balance` is ABSENT (undefined), not null. A bare
          // `!== null` lets undefined through and `.balances` then throws inside
          // render, which takes down the whole panel instead of showing the error
          // it was already carrying. Normalize first, then test.
          var bal = data.balance === undefined ? null : data.balance
          if (bal !== null && Array.isArray(bal.balances) && bal.balances.length > 0) {
            var b = bal.balances[0]
            balanceText = '余额 ' + b.totalBalance + ' ' + (b.currency || '')
          } else if (bal !== null) {
            balanceText = '余额未知'
          } else {
            balanceText = '余额未配置'
          }
        }

        var balanceNode = null
        if (wide && balanceText !== null) {
          balanceNode = React.createElement('span', { className: 'pmo-balance' }, balanceText)
        }

        // ── floating detail panel (wide mode, opens on hover) ───────────────────
        var popNode = null
        if (wide && open) {
          var rows = []
          if (failure !== null) {
            rows.push(React.createElement('div', { className: 'pmo-pop-title' }, '价格数据不可用'))
            rows.push(React.createElement('div', { className: 'pmo-pop-row' }, String(failure)))
            if (data !== null && data.syncedAt) {
              rows.push(React.createElement(
                'div', { className: 'pmo-pop-sync' },
                '最后一次成功同步 ' + formatBeijing(data.syncedAt) + '（北京时间）',
              ))
            }
          } else if (data === null || data.period === undefined) {
            rows.push(React.createElement('div', { className: 'pmo-pop-title' }, '加载中…'))
          } else {
            rows.push(React.createElement(
              'div',
              { className: 'pmo-pop-title' },
              data.period === 'peak' ? '当前：高峰时段（价格翻倍）' : '当前：空闲时段（半价）',
            ))
            var windows = (data.peakWindows || []).map(formatWindow).join('、')
            if (windows) {
              rows.push(React.createElement(
                'div',
                { className: 'pmo-pop-row' },
                '高峰窗口：' + (data.peakDayLabel ? data.peakDayLabel + ' ' : '') + windows +
                  (data.excludeHolidays ? '（北京时间，中国法定节假日按低谷计费）' : '（北京时间）'),
              ))
            }
            // The peak windows apply only on certain weekdays (e.g. 周一至周五):
            // today is off-peak because the weekday is outside that set.
            if (data.weekdayOffPeak) {
              rows.push(React.createElement(
                'div',
                { className: 'pmo-pop-row' },
                '今天为低谷时段（高峰仅限 ' + (data.peakDayLabel || '部分星期') + '）',
              ))
            } else if (data.weekendActive) {
              // Weekend rule (announced on the pricing page): from its effective
              // instant the listed weekdays are off-peak all day.
              rows.push(React.createElement('div', { className: 'pmo-pop-row' }, '周末全天按低谷价（不计高峰窗口）'))
            }
            // The page carves statutory holidays out of the peak window but this
            // plugin ships no holiday calendar, so a weekday holiday still reads as
            // peak here. Say so rather than let the badge imply a certainty it
            // does not have.
            if (data.holidayCaveat) {
              rows.push(React.createElement('div', { className: 'pmo-pop-warn' }, '⚠ ' + String(data.holidayCaveat)))
            }

            var popBal = data.balance === undefined ? null : data.balance
            var balMsg
            if (popBal !== null && Array.isArray(popBal.balances) && popBal.balances.length > 0) {
              balMsg = popBal.balances.map(function (item) {
                return '余额 ' + item.totalBalance + ' ' + (item.currency || '') +
                  '（赠送 ' + item.grantedBalance + ' + 充值 ' + item.toppedUpBalance + '）'
              }).join('；')
            } else if (popBal !== null) {
              balMsg = '余额未知'
            } else if (data.balanceError) {
              balMsg = String(data.balanceError).split('。')[0] + '。'
            } else {
              balMsg = '余额未配置'
            }
            rows.push(React.createElement('div', { className: 'pmo-pop-row pmo-pop-balance' }, balMsg))

            var prices = data.prices || {}
            var modelNames = Object.keys(prices)
            if (modelNames.length > 0) {
              rows.push(React.createElement('div', { className: 'pmo-pop-sub' }, '价格（元/百万 tokens）'))
              modelNames.forEach(function (model) {
                var k = prices[model]
                rows.push(React.createElement('div', { className: 'pmo-pop-model' }, model))
                rows.push(React.createElement(
                  'div', { className: 'pmo-pop-row' },
                  '输入(缓存命中)：峰 ' + k.inputCacheHit.peak + ' / 谷 ' + k.inputCacheHit.offPeak,
                ))
                rows.push(React.createElement(
                  'div', { className: 'pmo-pop-row' },
                  '输入(缓存未命中)：峰 ' + k.inputCacheMiss.peak + ' / 谷 ' + k.inputCacheMiss.offPeak,
                ))
                rows.push(React.createElement(
                  'div', { className: 'pmo-pop-row' },
                  '输出：峰 ' + k.output.peak + ' / 谷 ' + k.output.offPeak,
                ))
              })
            }
            if (data.sourceUrl) {
              rows.push(React.createElement('div', { className: 'pmo-pop-src' }, '来源：' + data.sourceUrl))
            }
            // Last successful sync with the official page, and a visible warning
            // when the auto-refresh keeps failing (page structure changed → the
            // old price table may be stale).
            if (data.syncError) {
              rows.push(React.createElement(
                'div',
                { className: 'pmo-pop-warn' },
                '⚠ ' + String(data.syncError) + '，价格表可能已过期' +
                  (data.syncedAt ? '（最后同步 ' + formatBeijing(data.syncedAt) + '）' : ''),
              ))
            } else if (data.syncedAt) {
              rows.push(React.createElement(
                'div',
                { className: 'pmo-pop-sync' },
                '价格表同步于 ' + formatBeijing(data.syncedAt) + '（北京时间）',
              ))
            }
          }
          popNode = React.createElement('div', { className: 'pmo-pop' }, rows)
        }

        // ── rail tooltip: the only info channel when the panel is unavailable ───
        var title = undefined
        if (!wide && failure !== null) {
          title = '价格数据不可用 · ' + String(failure).slice(0, 120)
        } else if (!wide && data !== null && data.period !== undefined) {
          title = (data.period === 'peak' ? '高峰（疯峰峰）' : '空闲（谷咕咕）') + ' · ' + (balanceText || '余额未知')
        }

        return React.createElement(
          'div',
          {
            'data-plugin': PLUGIN_ID,
            className: wide ? 'pmo-wrap' : 'pmo-wrap pmo-rail',
            ref: wrapRef,
            onMouseEnter: onEnter,
            onMouseLeave: onLeave,
          },
          React.createElement(
            'button',
            {
              type: 'button',
              className: 'pmo-root' + (open ? ' pmo-open' : ''),
              onClick: function () { setOpen(true) },
              title: title,
              'aria-expanded': open ? 'true' : undefined,
              'aria-label': 'DeepSeek 价格监控，悬停或点击查看详情',
            },
            pill,
            balanceNode,
          ),
          popNode,
        )
      }

      ctx.slots.inject('sidebar.footer.action', function () {
        return ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'price-monitor',
          order: 10,
        }, PricePanel)
      })
    }

    exports.apply = apply
    exports.inject = inject
    // 内部定位函数导出，供 smoke-test 做结构断言（框架只消费 apply/inject）。
    exports.__test = {
      foldRowSelector: FOLD_ROW_SELECTOR,
      ensureChatView: ensureChatView,
      chatTabsOf: chatTabsOf,
      findNodeBySeq: findNodeBySeq,
      minAnchorSeq: minAnchorSeq,
      scrollToNode: scrollToNode,
      locateFromSession: locateFromSession,
      chatSessionOf: chatSessionOf,
      currentSessionIdOf: currentSessionIdOf,
      openSessionNative: openSessionNative,
      foldNeeded: foldNeeded,
      setFolded: setFolded,
      findBubble: findBubble,
      titleInRow: titleInRow,
      processSidebarRow: processSidebarRow,
    }
    return module.exports
  },
})
