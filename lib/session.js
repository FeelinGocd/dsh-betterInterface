/**
 * dsh-better-interface — pure session-index primitives (host half).
 *
 * No DSH imports: pure transformations over plain event arrays, so the
 * index pipeline (Phase 2) is unit-testable in isolation (smoke-test.mjs).
 */

/** Concatenate the text blocks of a message's content into one string. */
export function messageText(message) {
  if (!message || !Array.isArray(message.content)) return ''
  return message.content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/**
 * Extract the user-message index from a session event log (Phase 2 data).
 * @param events - session events in seq order.
 * @returns [{ seq, time, text, chars }] in log order; empty array for an
 *   empty or non-array input.
 */
export function userMessages(events) {
  if (!Array.isArray(events)) return []
  const out = []
  for (const event of events) {
    if (event === undefined || event === null || event.type !== 'user/message') continue
    // 只保留真实用户输入（direct human prompt, source.kind === 'user'）。
    // synthetic agent.inject() 上下文（如插件运行通知、AGENTS.md、skill 内容、
    // goal continuation）也是 user/message 事件（source.kind !== 'user'），
    // 但它们不是用户对话文本，必须从索引中排除。
    // 参见 @deepseek-ai/dsh-session types.ts SessionEventMap['user/message']。
    const source = event.data && event.data.source
    if (!source || source.kind !== 'user') continue
    const text = messageText(event.data)
    out.push({
      seq: event.seq,
      time: typeof event.time === 'number' ? event.time : 0,
      text,
      chars: text.length,
    })
  }
  return out
}

/**
 * Extract the latest durable title from a session event log, if any.
 * DSH session/title event payload (dsh-session-title SessionTitleEventData):
 *   { title, messageSeqs, source } - field name is 'title' (previously
 *   misread as 'text'; fixed in Phase 5).
 * @param events - session events in seq order.
 * @returns the latest title text; undefined when no title event exists.
 */
export function sessionTitle(events) {
  if (!Array.isArray(events)) return undefined
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event.type === 'session/title' && event.data && typeof event.data.title === 'string') {
      return event.data.title
    }
  }
  return undefined
}
/**
 * Phase 4 — Branch 谱系纯函数。
 *
 * DSH fork 语义（dsh-session SessionStore.fork 源码）：
 *   - fork(source, boundary, childId) 把父 events.slice(0, boundary+1) 作为
 *     child 的 seed（boundary 是父事件 inclusive seq）；
 *   - child.header.parentSession = source.id，child.header.seedLength = seed.length
 *     ⇒ 分叉边界 seq = seedLength - 1；
 *   - child.firstLiveSeq = seed 长度：child 自己产生的事件从 firstLiveSeq 起。
 */

/**
 * 从持久化 event log 推导 firstLiveSeq（Cold Session 无 firstLiveSeq 字段时的等价物）。
 * dsh-session 语义：Session 构造时若 seed 末尾不是 session/end-seed，会把该标记 append
 * 在 seq = seed 长度处（= firstLiveSeq），占位后第一条新事件从 firstLiveSeq + 1 起；
 * 若 seed 本身以 end-seed 结尾则不重复标记（end-seed 在 seq = firstLiveSeq - 1）。
 * 两种情况下，持久化 log 中【最后一个】 session/end-seed 事件的 seq + 1 都等于
 * "child 自己的第一条新事件"的下界（前者 = firstLiveSeq + 1，后者 = firstLiveSeq）。
 * 没有 end-seed（无 seed 会话）返回 0。
 * @param events - 持久化 event log（seq 有序）。
 * @returns 用于 branchText 过滤"自己产生的新用户消息"的起始 seq。
 */
export function firstLiveSeqOf(events) {
  if (!Array.isArray(events)) return 0
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event && event.type === 'session/end-seed' && typeof event.seq === 'number') return event.seq + 1
  }
  return 0
}

/**
 * Branch 显示文本（Phase 5 规则）：优先真实 Session 名称（session/title 事件
 * 的 title 字段），没有 title 才回退 child 自己的第一条新用户消息
 * （seq >= firstLiveSeq，source.kind === 'user'）；都没有返回空串。
 * Live Session 直接读 child.firstLiveSeq；Cold Session（持久化 inspect 视图）
 * 由 firstLiveSeqOf 从 log 中的 session/end-seed 标记推导。
 * @param child - child Session（或其事件视图）。
 * @returns 分支文本（未截断，由端点统一截断）。
 */
export function branchText(child) {
  if (!child || !Array.isArray(child.events)) return ''
  const title = sessionTitle(child.events)
  if (title !== undefined && title !== '') return title
  const firstLive = typeof child.firstLiveSeq === 'number' ? child.firstLiveSeq : firstLiveSeqOf(child.events)
  for (const event of child.events) {
    if (event === undefined || event === null || typeof event.seq !== 'number') continue
    if (event.seq < firstLive) continue
    if (event.type !== 'user/message') continue
    const source = event.data && event.data.source
    if (!source || source.kind !== 'user') continue
    const text = messageText(event.data)
    if (text !== '') return text
  }
  return ''
}

/**
 * 把一个 child（Branch）挂到父 session 事件日志中对应的最后一条用户消息。
 * 分叉边界 seq = child.header.seedLength - 1；Branch 归到 events 中
 * seq <= boundary 的最后一条 source.kind==='user' 的 user/message
 * （boundary 本身可能是 turn/end 等非消息事件）。
 * @param events - 父 session 的 events（seq 有序）。
 * @param child - child Session（id / header.parentSession / header.seedLength / events / firstLiveSeq）。
 * @returns { seq, sessionId, parentSessionId, text, seedLength } 或 null（无法挂载）。
 */
export function branchAnchor(events, child) {
  if (!Array.isArray(events) || !child) return null
  const header = child.header || {}
  const seedLength = typeof header.seedLength === 'number' ? header.seedLength : undefined
  if (seedLength === undefined) return null
  const boundary = seedLength - 1
  let anchorSeq = null
  for (const event of events) {
    if (event === undefined || event === null || typeof event.seq !== 'number') continue
    if (event.seq > boundary) break
    if (event.type !== 'user/message') continue
    const source = event.data && event.data.source
    if (!source || source.kind !== 'user') continue
    anchorSeq = event.seq
  }
  if (anchorSeq === null) return null
  return {
    seq: anchorSeq,
    sessionId: child.id,
    parentSessionId: typeof header.parentSession === 'string' ? header.parentSession : undefined,
    text: branchText(child),
    seedLength,
  }
}

/**
 * 批量关联：父 events + 直接子 session 列表 → Map<seq, BranchItem[]>（创建顺序）。
 * 无法挂载的 child 直接忽略（不抛错）。
 * @param events - 父 session 的 events。
 * @param children - 直接子 session 列表。
 * @returns Map<锚点 seq, BranchItem[]>。
 */
export function branchIndex(events, children) {
  const map = new Map()
  if (!Array.isArray(children)) return map
  for (const child of children) {
    const anchor = branchAnchor(events, child)
    if (anchor === null) continue
    const list = map.get(anchor.seq)
    if (list) list.push(anchor)
    else map.set(anchor.seq, [anchor])
  }
  return map
}
