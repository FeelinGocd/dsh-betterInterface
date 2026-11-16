/**
 * dsh-better-interface — host 共用 HTTP 守卫（无 DSH 依赖，可单测）。
 * 三个端点（session / rename / session-location）共用。
 */

/** 以 JSON 响应结束请求（no-store，防索引缓存）。 */
export function sendJson(res, status, payload) {
  const text = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  })
  res.end(text)
}

/** Loopback-only 守卫（面板与 host 同源；非本地主机一律拒绝）。 */
export function isLoopback(req) {
  const host = req.headers?.host ?? ''
  return /^(?:127\.0\.0\.1|localhost|\[::1\])(?::[0-9]+)?$/i.test(host)
}

/**
 * 从 sessionPersistence.list() 的一项中取 header。
 * DSH ≥ v0.2：list() 返回 SessionPersistenceSnapshot[]（{ header, formatStatus,
 * revision, sizeBytes }）；≤ v0.1.x 直接返回 SessionHeader[]。两种都兼容。
 * @param entry - 列表项。
 * @returns 可用 header，或 undefined（结构不认识）。
 */
export function persistedHeaderOf(entry) {
  if (entry === null || entry === undefined || typeof entry !== 'object') return undefined
  const nested = entry.header
  const header = nested !== null && nested !== undefined && typeof nested === 'object' ? nested : entry
  return typeof header.id === 'string' ? header : undefined
}

/**
 * 读取 Host Session 的事件日志（只读快照）。
 * DSH ≤ v0.1.x 公开 `session.events`；DSH ≥ v0.2 把事件日志设为私有，
 * 改用 `session.snapshotEvents()`（返回冻结数组；官方 session-query 同款）。
 * @param session - ctx.sessions.get(id) 的返回。
 * @returns 事件数组；不可用时返回空数组。
 */
export function sessionEventsOf(session) {
  if (session === null || session === undefined) return []
  if (typeof session.snapshotEvents === 'function') {
    try {
      const events = session.snapshotEvents()
      if (Array.isArray(events)) return events
    } catch { /* 回退旧字段 */ }
  }
  return Array.isArray(session.events) ? session.events : []
}

/** 收集请求体为 UTF-8 文本（node http IncomingMessage 流）。 */
export function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}
