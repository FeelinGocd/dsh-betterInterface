/**
 * dsh-better-interface — 会话状态管理端点（Phase 6 管理界面数据源）。
 *
 *   GET  /better-interface/manage-sessions → { sessions: [{ sessionId, state, live }] }
 *   POST /better-interface/session-state { sessionId, state } → { ok, sessionId, state }
 *
 * 状态（用户视角 metadata，非 DSH 原生状态）：
 *   active  默认；hidden 插件视图隐藏；archived 插件视图归档（可逆）。
 *   存储走 DSH 官方 storageDomain（KV 域存储：schema 校验 + backend 持久化 +
 *   变更事件；workspace / message-feedback 同款）。不修改 JSONL / events /
 *   DSH persistence——只改变用户看到的视图（目标文档 §17）。
 *   删除由 session-delete 路由处理，独立于状态机。
 *
 * 注：valueSchema 是自写的 { parse } 验证器（运行时仅依赖 parse 方法），
 * 保持插件零依赖（不装 zod）；记录结构极简（{ state }），语义与 zod 等价。
 */
import { sendJson, isLoopback, readBody, persistedHeaderOf } from './guards.js'

export const BETTER_INTERFACE_STATES = ['active', 'hidden', 'archived']

/** Domain 声明：sessions 表 { state }。name/version 与后端单元一致。
 * 注意：单元名必须匹配 storage 的 UNIT_NAME_RE（/^[a-z][a-z0-9_]*$/）——
 * 不能用连字符（better-interface 非法），官方 message_feedback 同款下划线命名。 */
export const domainSpec = {
  name: 'better_interface',
  version: 1,
  tables: {
    sessions: {
      valueSchema: {
        parse(raw) {
          if (raw !== null && typeof raw === 'object'
            && typeof raw.state === 'string'
            && BETTER_INTERFACE_STATES.includes(raw.state)) {
            return { state: raw.state }
          }
          throw new Error('invalid better-interface session state record')
        },
      },
    },
  },
}

/** 打开 storageDomain 域并返回 sessions 表（不可用时返回 undefined）。 */
export async function openStateTable(storageDomain, ctx) {
  if (storageDomain === undefined || storageDomain === null || typeof storageDomain.open !== 'function') {
    ctx.logger?.warn?.('[dsh-better-interface] storageDomain unavailable: session states disabled')
    return undefined
  }
  try {
    const domain = await storageDomain.open(domainSpec)
    ctx.effect(() => () => { try { domain.close() } catch (e) { /* 关闭失败不阻断 */ } }, 'better-interface.domainClose')
    return domain.table('sessions')
  } catch (e) {
    ctx.logger?.warn?.('[dsh-better-interface] open state domain failed: ' + String(e && e.message ? e.message : e))
    return undefined
  }
}

/**
 * 全量会话 + 状态列表（corpus：persistence.list + sessions.list 按 id 合并、
 * live 优先——与 branch 枚举同一范式）。
 * 状态合并（Phase 6 + 原生归档联动）：
 *   - DSH 原生归档（workspaceRegistry.archivedSessionIds）→ state=archived、
 *     nativeArchived=true（侧栏已隐藏、无 unarchive API、不可经插件恢复）；
 *   - 否则用插件 metadata（storageDomain：active/hidden/archived），缺省 active。
 */
export function makeManageHandler({ sessions, persistence, stateTable, archivedIds, ctx }) {
  return async function handleManageSessions(req, res) {
    if (req.method !== undefined && req.method !== 'GET') {
      return sendJson(res, 405, { code: 'METHOD_NOT_ALLOWED', error: 'GET only' })
    }
    if (!isLoopback(req)) return sendJson(res, 403, { error: 'forbidden' })
    const corpus = new Map()
    if (persistence !== undefined && persistence !== null && typeof persistence.list === 'function') {
      try {
        const persisted = await persistence.list()
        if (Array.isArray(persisted)) {
          for (const entry of persisted) {
            const header = persistedHeaderOf(entry)
            if (header !== undefined) corpus.set(header.id, { header, live: false })
          }
        }
      } catch (e) {
        ctx.logger?.warn?.('[dsh-better-interface] manage list failed: ' + String(e && e.message ? e.message : e))
      }
    }
    if (typeof sessions.list === 'function') {
      try {
        for (const liveSession of sessions.list()) {
          if (liveSession && liveSession.header && typeof liveSession.header.id === 'string') {
            corpus.set(liveSession.header.id, { header: liveSession.header, live: true })
          }
        }
      } catch (e) {
        ctx.logger?.warn?.('[dsh-better-interface] manage live list failed: ' + String(e && e.message ? e.message : e))
      }
    }
    const nativeList = typeof archivedIds === 'function' ? archivedIds() : archivedIds
    const nativeArchivedSet = Array.isArray(nativeList) && nativeList.length > 0
      ? new Set(nativeList)
      : null
    const out = []
    for (const [id, record] of corpus) {
      let state = 'active'
      let nativeArchived = false
      if (nativeArchivedSet !== null && nativeArchivedSet.has(id)) {
        state = 'archived'
        nativeArchived = true
      } else if (stateTable !== undefined) {
        try {
          const row = stateTable.get(id)
          if (row && typeof row.state === 'string') state = row.state
        } catch { /* 读取失败按 active 处理 */ }
      }
      out.push({ sessionId: id, state, live: record.live, nativeArchived })
    }
    // 稳定顺序：id 字典序（管理界面展示稳定）
    out.sort((a, b) => (a.sessionId < b.sessionId ? -1 : 1))
    return sendJson(res, 200, { sessions: out, states: BETTER_INTERFACE_STATES })
  }
}

/** 切换会话状态（写 metadata；不触碰 Session 本体）。 */
export function makeStateHandler({ sessions, persistence, stateTable, archivedIds, ctx }) {
  return async function handleSessionState(req, res) {
    if (req.method !== 'POST') return sendJson(res, 405, { code: 'METHOD_NOT_ALLOWED', error: 'POST only' })
    if (!isLoopback(req)) return sendJson(res, 403, { error: 'forbidden' })
    let bodyText
    try {
      bodyText = await readBody(req)
    } catch {
      return sendJson(res, 400, { code: 'BAD_REQUEST', error: 'invalid request body' })
    }
    let payload
    try {
      payload = JSON.parse(bodyText === '' ? '{}' : bodyText)
    } catch {
      return sendJson(res, 400, { code: 'BAD_REQUEST', error: 'invalid json body' })
    }
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : ''
    const state = typeof payload.state === 'string' ? payload.state : ''
    if (sessionId === '') {
      return sendJson(res, 400, { code: 'BAD_REQUEST', error: 'sessionId is required' })
    }
    if (!BETTER_INTERFACE_STATES.includes(state)) {
      return sendJson(res, 400, { code: 'STATE_INVALID', error: 'state must be one of ' + BETTER_INTERFACE_STATES.join('/') })
    }
    if (stateTable === undefined) {
      return sendJson(res, 503, { code: 'STATE_UNAVAILABLE', error: 'session states are unavailable: no storage domain' })
    }
    // 原生归档的会话不可经插件切换（DSH 无 unarchive API；侧栏已隐藏）。
    const nativeList = typeof archivedIds === 'function' ? archivedIds() : archivedIds
    if (Array.isArray(nativeList) && nativeList.includes(sessionId)) {
      return sendJson(res, 400, { code: 'NATIVE_ARCHIVED', error: '该会话已被 DSH 原生归档，无法通过插件恢复' })
    }
    // 会话必须存在（live 或持久化）。
    let known = sessions.get(sessionId) !== undefined
    if (!known && persistence !== undefined && persistence !== null && typeof persistence.list === 'function') {
      try {
        const headers = await persistence.list()
        known = Array.isArray(headers) && headers.some((entry) => {
          const header = persistedHeaderOf(entry)
          return header !== undefined && header.id === sessionId
        })
      } catch { known = false }
    }
    if (!known) {
      return sendJson(res, 404, { code: 'SESSION_NOT_FOUND', error: 'session ' + sessionId + ' not found' })
    }
    try {
      await stateTable.put(sessionId, { state })
      return sendJson(res, 200, { ok: true, sessionId, state })
    } catch (e) {
      ctx.logger?.warn?.('[dsh-better-interface] state write failed: ' + String(e && e.message ? e.message : e))
      return sendJson(res, 500, { code: 'STATE_WRITE_FAILED', error: 'state write failed' })
    }
  }
}
