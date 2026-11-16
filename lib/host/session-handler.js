/**
 * dsh-better-interface — GET /better-interface/session?sessionId=…
 *
 * Phase 2.1 payload：用户消息索引（{ seq, text }，正序，text 截断 previewChars）。
 * Phase 4.1：Branch 枚举走 Live/Cold 合并 corpus（lib/host/corpus.js），
 * 文本读取 live 直接取 / cold inspect（只读、不 resume、不 open）。
 * ?debug=1 附加只读调查字段（事件/来源分布 + 样本；正常响应不携带）。
 * 原 Session 永远只读：events 是 deep-frozen 快照，本端点不写任何东西。
 */
import { userMessages, messageText } from '../session.js'
import { sendJson, isLoopback, sessionEventsOf } from './guards.js'
import { buildBranchCorpus } from './corpus.js'

export function makeSessionHandler({ sessions, persistence, previewChars, ctx, stateTable, archivedIds }) {
  return async function handleSession(req, res) {
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
    const session = sessions.get(sessionId)
    if (session === undefined) {
      return sendJson(res, 404, { code: 'SESSION_NOT_FOUND', error: 'session ' + sessionId + ' not found' })
    }

    // DSH ≥ v0.2 用 session.snapshotEvents()（.events 已私有）；旧版回退 .events。
    const parentEvents = sessionEventsOf(session)
    const { branchMap, branchAvailable } = await buildBranchCorpus({
      sessions,
      persistence,
      parentSessionId: sessionId,
      parentEvents,
      logger: ctx.logger,
      stateTable,
      archivedIds,
    })

    const messages = userMessages(parentEvents).map((message) => {
      const branches = (branchMap.get(message.seq) || []).map((branch) => ({
        sessionId: branch.sessionId,
        parentSessionId: branch.parentSessionId,
        text: branch.text.length > previewChars ? branch.text.slice(0, previewChars) + '…' : branch.text,
        seedLength: branch.seedLength,
      }))
      return {
        seq: message.seq,
        text: message.text.length > previewChars ? message.text.slice(0, previewChars) + '…' : message.text,
        branches,
      }
    })

    const debug = parsedUrl.searchParams?.get('debug')
    if (debug === '1' || debug === 'true') {
      const eventTypes = {}
      const sourceKinds = {}
      const userSamples = []
      for (const event of parentEvents) {
        eventTypes[event.type] = (eventTypes[event.type] || 0) + 1
      }
      for (const event of parentEvents) {
        if (event.type !== 'user/message') continue
        const data = event.data
        const kind = (data && data.source && data.source.kind) || '(missing)'
        sourceKinds[kind] = (sourceKinds[kind] || 0) + 1
        if (userSamples.length < 12) {
          const blocks = Array.isArray(data && data.content)
            ? data.content.map((block) => (block && typeof block.type === 'string' ? block.type : '(unknown)'))
            : null
          userSamples.push({
            seq: event.seq,
            sourceKind: kind,
            blockTypes: blocks,
            text: messageText(data).slice(0, 120),
          })
        }
      }
      return sendJson(res, 200, { sessionId, messages, branchAvailable, debug: { eventTypes, sourceKinds, userSamples } })
    }
    return sendJson(res, 200, { sessionId, messages, branchAvailable })
  }
}
