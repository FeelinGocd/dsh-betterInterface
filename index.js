/**
 * dsh-better-interface — Host 入口（薄壳组装）。
 *
 * 按功能分文件（便于维护）：
 *   lib/host/guards.js          共用 HTTP 守卫（sendJson / isLoopback / readBody）
 *   lib/host/corpus.js          Live/Cold 合并枚举 + Branch 挂载（Phase 4.1）
 *   lib/host/session-handler.js  GET  /better-interface/session（索引 + Branch）
 *   lib/host/rename-handler.js   POST /better-interface/rename（Live 重命名）
 *   lib/host/location-handler.js GET  /better-interface/session-location（Phase 6 📂）
 *   lib/host/manage-handler.js   GET  /better-interface/manage-sessions + POST /session-state（Phase 6 状态）
 *   lib/host/delete-handler.js   DELETE /better-interface/session-delete（已归档且关闭的会话）
 *   lib/session.js              纯函数（索引过滤 / title / Branch 挂载推导）
 *
 * 端点（loopback-only；method 守卫在各 handler 内）：
 *   GET  /better-interface/session?sessionId=…&debug=1
 *   POST /better-interface/rename { sessionId, title }
 *   GET  /better-interface/session-location?sessionId=…
 *   GET  /better-interface/manage-sessions
 *   POST /better-interface/session-state { sessionId, state }
 *   DELETE /better-interface/session-delete?sessionId=…
 *
 * 依赖经模块级 export const inject 声明（与 cordis.patch.yml 行级 inject
 * 保持一致）；cordis 保持 fiber PENDING 直到服务就绪，apply() 内直接访问
 * ctx.<service> 才是安全的（未声明即访问会抛 "cannot get property X without
 * inject"）。原 Session 永远只读（events 为 deep-frozen 快照）。
 */
import { makeSessionHandler } from './lib/host/session-handler.js'
import { makeRenameHandler } from './lib/host/rename-handler.js'
import { makeLocationHandler } from './lib/host/location-handler.js'
import { makeDeleteHandler } from './lib/host/delete-handler.js'
import { makeManageHandler, makeStateHandler, openStateTable } from './lib/host/manage-handler.js'

export const name = 'dsh-better-interface'

/** Required services: the fiber waits for these before apply() runs. */
export const inject = ['webServer', 'sessions', 'sessionPersistence', 'sessionTitle', 'storageDomain', 'workspaceRegistry']

export async function apply(ctx, config = {}) {
  const { previewChars = 30 } = config
  const sessions = ctx.sessions
  const persistence = ctx.sessionPersistence
  const titles = ctx.sessionTitle
  const webServer = ctx.webServer

  // Phase 6：会话状态 metadata（storageDomain 官方 KV 域存储）。
  const stateTable = await openStateTable(ctx.storageDomain, ctx)
  // 原生归档集合读取函数（workspaceRegistry.archivedSessionIds 是动态 getter，
  // 每次读取取最新值——归档是运行时操作，不能存 apply 时的快照）。
  const archivedIds = () => (ctx.workspaceRegistry && typeof ctx.workspaceRegistry.archivedSessionIds !== 'undefined')
    ? ctx.workspaceRegistry.archivedSessionIds
    : []

  const d1 = webServer.register({
    kind: 'exact',
    path: '/better-interface/session',
    handler: makeSessionHandler({ sessions, persistence, previewChars, ctx, stateTable, archivedIds }),
  })
  const d2 = webServer.register({
    kind: 'exact',
    path: '/better-interface/rename',
    handler: makeRenameHandler({ sessions, persistence, titles, ctx }),
  })
  const d3 = webServer.register({
    kind: 'exact',
    path: '/better-interface/session-location',
    handler: makeLocationHandler({ sessions, persistence, ctx }),
  })
  const d4 = webServer.register({
    kind: 'exact',
    path: '/better-interface/manage-sessions',
    handler: makeManageHandler({ sessions, persistence, stateTable, archivedIds, ctx }),
  })
  const d5 = webServer.register({
    kind: 'exact',
    path: '/better-interface/session-state',
    handler: makeStateHandler({ sessions, persistence, stateTable, archivedIds, ctx }),
  })
  const d6 = webServer.register({
    kind: 'exact',
    path: '/better-interface/session-delete',
    handler: makeDeleteHandler({ sessions, persistence, stateTable, archivedIds, ctx }),
  })
  ctx.effect(() => [d1, d2, d3, d4, d5, d6], 'better-interface: session routes')
  ctx.logger?.info?.('[dsh-better-interface] host applied (index + branches + rename + location + session states)')
}
