/**
 * dsh-better-interface — POST /better-interface/rename { sessionId, title }
 *
 * Phase 5：Live Session 重命名（经 DSH SessionTitleService.rename → append
 * session/title 事件，pins 标题）；Cold Session 明确拒绝（不自动 resume，文档
 * §15 决策）；sessionTitle 服务缺失时安全降级（503，索引不受影响）。
 * 不修改任何历史 events。
 */
import { sendJson, isLoopback, readBody, persistedHeaderOf } from './guards.js'

export function makeRenameHandler({ sessions, persistence, titles, ctx }) {
  return async function handleRename(req, res) {
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
    const title = typeof payload.title === 'string' ? payload.title : ''
    if (sessionId === '') {
      return sendJson(res, 400, { code: 'BAD_REQUEST', error: 'sessionId is required' })
    }
    if (title.trim() === '') {
      return sendJson(res, 400, { code: 'TITLE_INVALID', error: 'title must contain visible characters' })
    }
    const session = sessions.get(sessionId)
    if (session === undefined) {
      // Cold（持久化存在但未加载）与未知会话区分：只读查询持久化判断。
      let persisted = false
      try {
        if (persistence !== undefined && persistence !== null && typeof persistence.list === 'function') {
          const headers = await persistence.list()
          persisted = Array.isArray(headers) && headers.some((entry) => {
            const header = persistedHeaderOf(entry)
            return header !== undefined && header.id === sessionId
          })
        }
      } catch { persisted = false }
      if (persisted) {
        return sendJson(res, 400, { code: 'SESSION_NOT_LIVE', error: '请先打开该 Branch 后再重命名' })
      }
      return sendJson(res, 404, { code: 'SESSION_NOT_FOUND', error: 'session ' + sessionId + ' not found' })
    }
    if (titles === undefined || titles === null || typeof titles.rename !== 'function') {
      return sendJson(res, 503, { code: 'RENAME_UNAVAILABLE', error: 'renaming is unavailable: no session-title service' })
    }
    try {
      const snapshot = titles.rename(session, title)
      return sendJson(res, 200, { ok: true, sessionId, title: snapshot.title, seq: snapshot.eventSeq })
    } catch (e) {
      if (e && e.name === 'SessionTitleInvalidError') {
        return sendJson(res, 400, { code: 'TITLE_INVALID', error: String(e && e.message ? e.message : 'title must contain visible characters') })
      }
      ctx.logger?.warn?.('[dsh-better-interface] rename failed: ' + String(e && e.message ? e.message : e))
      return sendJson(res, 500, { code: 'RENAME_FAILED', error: 'rename failed' })
    }
  }
}
