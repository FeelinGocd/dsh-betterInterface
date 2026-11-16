/**
 * dsh-better-interface — GET /better-interface/session-location?sessionId=…
 *
 * Phase 6「打开对应文件夹」：返回会话文件在磁盘上的绝对路径与所在目录。
 * 官方路径 API：sessionPersistence.locate(header)（session-persistence
 * src/index.ts:96）→ { kind, path }。locate 是 side-effect-free locator：
 * 纯路径计算，不读取 / 不创建 / 不 materialize / 不 resume / 不 open。
 * JSONL backend 返回每会话一个文件（.jsonl.zstd）；SQLite 等无单文件
 * artifact 的 backend 返回 undefined → 503 LOCATION_UNAVAILABLE。
 * 打开动作由 client 侧 openFolderNative() 完成（DSH ≥ v0.1.2 用官方
 * ctx.remote.session.openWorkspacePath，旧版回退 ctx.workspaces.openPath；host 只读定位）。
 */
import { dirname } from 'node:path'
import { sendJson, isLoopback, persistedHeaderOf } from './guards.js'

export function makeLocationHandler({ sessions, persistence, ctx }) {
  return async function handleSessionLocation(req, res) {
    if (req.method !== undefined && req.method !== 'GET') {
      return sendJson(res, 405, { code: 'METHOD_NOT_ALLOWED', error: 'GET only' })
    }
    if (!isLoopback(req)) return sendJson(res, 403, { error: 'forbidden' })
    let parsedUrl
    try {
      parsedUrl = new URL(req.url ?? '/', 'http://x')
    } catch {
      return sendJson(res, 400, { code: 'BAD_REQUEST', error: 'invalid request url' })
    }
    const sessionId = parsedUrl.searchParams?.get('sessionId') ?? ''
    if (sessionId === '') {
      return sendJson(res, 400, { code: 'BAD_REQUEST', error: 'sessionId is required' })
    }
    if (persistence === undefined || persistence === null || typeof persistence.locate !== 'function') {
      return sendJson(res, 503, { code: 'LOCATION_UNAVAILABLE', error: 'session file location is unavailable: no persistence locator' })
    }

    // header 来源：live 优先（内存 header）；cold 从 persistence.list() 的
    // header 行里找（不读文件，符合 locate "without materializing" 约束）。
    let header
    let live = false
    const session = sessions.get(sessionId)
    if (session !== undefined) {
      // 真实 DSH Session 必有 header；缺失时用 { id } 兜底（locate 只依赖 id）。
      header = (session.header && typeof session.header.id === 'string') ? session.header : { id: sessionId }
      live = true
    } else {
      try {
        const headers = await persistence.list()
        if (Array.isArray(headers)) {
          const found = headers.map(persistedHeaderOf).find((h) => h !== undefined && h.id === sessionId)
          if (found !== undefined) header = found
        }
      } catch (e) {
        ctx.logger?.warn?.('[dsh-better-interface] session-location list failed: ' + String(e && e.message ? e.message : e))
      }
    }
    if (header === undefined) {
      return sendJson(res, 404, { code: 'SESSION_NOT_FOUND', error: 'session ' + sessionId + ' not found' })
    }

    let location
    try {
      location = persistence.locate(header)
    } catch (e) {
      ctx.logger?.warn?.('[dsh-better-interface] locate failed: ' + String(e && e.message ? e.message : e))
      return sendJson(res, 503, { code: 'LOCATION_UNAVAILABLE', error: 'session file location failed' })
    }
    if (location === undefined || typeof location.path !== 'string' || location.path === '') {
      return sendJson(res, 503, { code: 'LOCATION_UNAVAILABLE', error: 'this persistence backend does not expose per-session files' })
    }
    return sendJson(res, 200, {
      sessionId,
      path: location.path,
      folder: dirname(location.path),
      kind: typeof location.kind === 'string' ? location.kind : 'file',
      live,
    })
  }
}
