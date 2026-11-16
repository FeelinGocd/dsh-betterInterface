import { lstat, mkdir, mkdtemp, realpath, rename, rmdir, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { isLoopback, sendJson } from './guards.js'
import { storedSessionState } from './manage-handler.js'

const sessionIdPattern = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/

export function makeDeleteHandler({ sessions, persistence, stateTable, archivedIds, ctx }) {
  function isArchived(sessionId) {
    const native = archivedIds()
    return (Array.isArray(native) && native.includes(sessionId)) || storedSessionState(stateTable, sessionId) === 'archived'
  }

  return async function handleDeleteSession(req, res) {
    if (req.method !== 'DELETE') return sendJson(res, 405, { error: 'DELETE only' })
    if (!isLoopback(req)) return sendJson(res, 403, { error: 'forbidden' })
    const connection = ctx.get?.('connection')
    const origin = req.headers.origin
    const sameOrigin = origin === 'http://' + req.headers.host || origin === 'https://' + req.headers.host
    // Desktop forwards the authenticated Host cookie and strips Origin.
    // Hosts predating request admission retain the same-origin Web check.
    const rejection = typeof connection?.requestRejection === 'function'
      ? connection.requestRejection(req)
      : sameOrigin ? undefined : 403
    if (rejection !== undefined) {
      return sendJson(res, rejection, { error: '请从本机 DSH 设置页删除会话' })
    }
    const sessionId = new URL(req.url ?? '/', 'http://localhost').searchParams.get('sessionId') ?? ''
    if (!sessionIdPattern.test(sessionId)) return sendJson(res, 400, { error: '无效的会话 ID' })
    if (typeof persistence?.locate !== 'function' || typeof persistence?.open !== 'function') {
      return sendJson(res, 503, { error: '当前会话存储不支持删除' })
    }
    if (sessions.get(sessionId) !== undefined) {
      return sendJson(res, 409, { error: '会话仍在 DSH 中打开，关闭后再试' })
    }

    let handle
    let trashEntry
    let moved = false
    try {
      if (!isArchived(sessionId)) return sendJson(res, 409, { error: '请先归档该会话，再删除' })
      // The persistence handle acquires DSH's cross-process write lease.
      handle = await persistence.open(sessionId, 'write')
      if (sessions.get(sessionId) !== undefined) {
        return sendJson(res, 409, { error: '会话仍在 DSH 中打开，关闭后再试' })
      }
      const header = handle.header
      const location = header?.id === sessionId ? persistence.locate(header) : undefined
      if (location?.kind !== 'jsonl' || typeof location.path !== 'string' || !isAbsolute(location.path)) {
        return sendJson(res, 503, { error: '当前会话存储不提供独立的 JSONL 记录' })
      }
      const file = resolve(location.path)
      const folder = dirname(file)
      const storageRoot = dirname(dirname(folder))
      const parts = relative(storageRoot, file).split(/[\\/]/)
      if (parts.length !== 3 || parts[1] !== sessionId || !/\.jsonl(?:\.zstd)?$/.test(basename(file))
        || !(await lstat(file)).isFile() || await realpath(file) !== file) {
        return sendJson(res, 409, { error: '无法验证该会话有独立的存储目录' })
      }
      const trash = join(dirname(storageRoot), 'better-interface-trash')
      await mkdir(trash, { mode: 0o700 }).catch((error) => { if (error.code !== 'EEXIST') throw error })
      if (!(await lstat(trash)).isDirectory() || await realpath(trash) !== trash) {
        return sendJson(res, 409, { error: '无法验证本地回收目录' })
      }
      trashEntry = await mkdtemp(join(trash, sessionId + '-'))
      await writeFile(join(trashEntry, 'restore.json'), JSON.stringify({ originalPath: folder }), { mode: 0o600 })
      if (!isArchived(sessionId)) return sendJson(res, 409, { error: '会话已取消归档，请重新归档后再删除' })
      // Move the complete conversation atomically so an older log generation cannot resurface.
      await rename(folder, join(trashEntry, 'session'))
      moved = true
      return sendJson(res, 200, { ok: true })
    } catch (error) {
      if (error?.name === 'SessionAlreadyOwnedError') {
        return sendJson(res, 409, { error: '另一个 DSH 进程正在使用该会话' })
      }
      if (error?.name === 'SessionPersistenceNotFoundError') {
        return sendJson(res, 404, { error: '会话记录已不存在' })
      }
      ctx.logger?.warn?.('[dsh-better-interface] move session to trash failed: ' + String(error))
      return sendJson(res, 500, { error: '无法将会话移到本地回收目录' })
    } finally {
      if (handle !== undefined) {
        try { await handle.close() } catch (error) {
          ctx.logger?.warn?.('[dsh-better-interface] session write lease release failed: ' + String(error))
        }
      }
      if (trashEntry !== undefined && !moved) {
        await unlink(join(trashEntry, 'restore.json')).catch(() => {})
        await rmdir(trashEntry).catch(() => {})
      }
    }
  }
}
