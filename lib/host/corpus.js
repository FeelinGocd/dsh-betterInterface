/**
 * dsh-better-interface — Live/Cold Branch 枚举（Phase 4.1）。
 *
 * 根因：SessionStore.list() 只含 live（[...this.store.values()]，dsh-session
 * src/index.ts:1063），重启后未打开的会话是 Cold（持久化但未加载）→ list()
 * 找不到。官方「全量枚举」范式（subagent/list-children.ts prepareListing）：
 * sessionPersistence.list() 建 corpus + sessions.list() live 优先覆盖。
 * Cold 只读读取用 persistence.inspect()（不可变 { meta, events }），
 * 不 resume / 不 open / 不改 current / 不修改 DSH Core。
 */
import { branchAnchor, branchIndex } from '../session.js'
import { persistedHeaderOf, sessionEventsOf } from './guards.js'

/** 读取一个 child 的事件视图：live 直接取内存快照；cold 用 persistence.inspect。 */
export async function resolveChildEvents(persistence, record, logger) {
  if (record.live) {
    // DSH ≥ v0.2：live session 的 .events 已私有 → snapshotEvents()。
    const events = sessionEventsOf(record.live)
    if (!Array.isArray(events)) return null
    return {
      events,
      firstLiveSeq: typeof record.live.firstLiveSeq === 'number' ? record.live.firstLiveSeq : undefined,
    }
  }
  if (persistence === undefined || persistence === null) return null
  // DSH ≤ v0.1.x：persistence.inspect(id) → { meta, events }（只读、不 resume）。
  if (typeof persistence.inspect === 'function') {
    try {
      const inspected = await persistence.inspect(record.header.id)
      if (inspected && Array.isArray(inspected.events)) return { events: inspected.events, firstLiveSeq: undefined }
    } catch (e) {
      logger?.warn?.('[dsh-better-interface] inspect branch ' + record.header.id + ' failed: ' + String(e && e.message ? e.message : e))
    }
  }
  // DSH ≥ v0.2：inspect 已移除；用只读 handle 读事件（read 不取所有权、不 resume）。
  if (typeof persistence.open === 'function') {
    let handle
    try {
      handle = await persistence.open(record.header.id, 'read')
      const result = await handle.read()
      const events = result && Array.isArray(result.events) ? result.events : []
      return { events, firstLiveSeq: undefined }
    } catch (e) {
      logger?.warn?.('[dsh-better-interface] read branch ' + record.header.id + ' failed: ' + String(e && e.message ? e.message : e))
      return null
    } finally {
      try { await handle?.close() } catch { /* 关闭失败不阻断 */ }
    }
  }
  return null
}

/**
 * Live/Cold 合并枚举 + Branch 挂载。
 * @param sessions - ctx.sessions（get / list）
 * @param persistence - ctx.sessionPersistence（list / inspect）
 * @param parentSessionId - 父 Session id（过滤 header.parentSession === id）
 * @param parentEvents - 父 Session 的 events（用于 branchAnchor 挂载）
 * @param logger - ctx.logger（降级告警）
 * @returns { branchMap, branchAvailable }
 *   branchMap: Map<锚点 seq, BranchItem[]>
 *   branchAvailable: false 表示谱系数据可能不完整（persistence 缺失/抛错），
 *     索引与 live 分支仍可用（安全降级）。
 */
export async function buildBranchCorpus({ sessions, persistence, parentSessionId, parentEvents, logger, stateTable, archivedIds }) {
  let branchAvailable = true
  let branchMap = new Map()
  try {
    const corpus = new Map()
    if (persistence !== undefined && persistence !== null && typeof persistence.list === 'function') {
      try {
        const persisted = await persistence.list()
        if (Array.isArray(persisted)) {
          for (const entry of persisted) {
            const header = persistedHeaderOf(entry)
            if (header !== undefined) corpus.set(header.id, { header, live: undefined })
          }
        }
      } catch (e) {
        branchAvailable = false
        logger?.warn?.('[dsh-better-interface] persistence.list failed, falling back to live-only: ' + String(e && e.message ? e.message : e))
      }
    } else {
      branchAvailable = false
    }
    if (typeof sessions.list === 'function') {
      try {
        for (const liveSession of sessions.list()) {
          if (liveSession && liveSession.header && typeof liveSession.header.id === 'string') {
            corpus.set(liveSession.header.id, { header: liveSession.header, live: liveSession })
          }
        }
      } catch (e) {
        logger?.warn?.('[dsh-better-interface] sessions.list failed: ' + String(e && e.message ? e.message : e))
      }
    }
    // Phase 6 联动：hidden / archived 的 child 从索引过滤（插件视图状态）；
    // DSH 原生归档（archivedSessionIds）同样过滤（侧栏已隐藏，保持一致）。
    // stateTable / archivedIds 缺失时不过滤——安全降级。
    const children = [...corpus.values()].filter((r) => {
      if (!r.header || r.header.parentSession !== parentSessionId) return false
      const nativeList = typeof archivedIds === 'function' ? archivedIds() : archivedIds
      if (Array.isArray(nativeList) && nativeList.includes(r.header.id)) return false
      if (stateTable !== undefined) {
        try {
          const row = stateTable.get(r.header.id)
          if (row && (row.state === 'hidden' || row.state === 'archived')) return false
        } catch { /* 状态读取失败按可见处理 */ }
      }
      return true
    })
    const childSessions = []
    for (const record of children) {
      if (typeof record.header.seedLength !== 'number') continue
      const pre = branchAnchor(parentEvents, { id: record.header.id, header: record.header })
      if (pre === null) continue
      const resolved = await resolveChildEvents(persistence, record, logger)
      if (resolved === null) continue
      childSessions.push({
        id: record.header.id,
        header: record.header,
        events: resolved.events,
        firstLiveSeq: resolved.firstLiveSeq,
      })
    }
    branchMap = branchIndex(parentEvents, childSessions)
  } catch (e) {
    branchAvailable = false
    logger?.warn?.('[dsh-better-interface] branch resolution failed: ' + String(e && e.message ? e.message : e))
  }
  return { branchMap, branchAvailable }
}
