import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { makeDeleteHandler } from './lib/host/delete-handler.js'

test('delete requires an authenticated request and an archived, closed session', async (t) => {
  const parent = await realpath(tmpdir())
  const fixture = await mkdtemp(join(parent, 'dsh-delete-fixture-'))
  assert.equal(dirname(await realpath(fixture)), parent)
  t.after(() => rm(fixture, { recursive: true, force: true }))
  const folder = join(fixture, 'sessions', 'project', 'conversation')
  const record = join(folder, 'session.jsonl.zstd')
  await mkdir(folder, { recursive: true })
  await writeFile(record, 'current')
  await writeFile(join(folder, 'older.jsonl.zstd'), 'older')
  const other = join(dirname(folder), 'other.jsonl.zstd')
  await writeFile(other, 'another conversation')
  let live = true
  let state = 'active'
  let nativeArchive = false
  let restoreDuringOpen = false
  let opens = 0
  let closes = 0
  const handler = makeDeleteHandler({
    sessions: { get: () => live ? {} : undefined },
    persistence: {
      async open(id, mode) {
        assert.equal(id, 'conversation')
        assert.equal(mode, 'write')
        opens++
        if (restoreDuringOpen) state = 'active'
        return { header: { id }, close: async () => { closes++ } }
      },
      locate: () => ({ kind: 'jsonl', path: record }),
    },
    stateTable: { get: () => ({ state }) },
    archivedIds: () => nativeArchive ? ['conversation'] : [],
    ctx: {
      get: () => ({
        requestRejection({ headers }) {
          if (headers.origin !== undefined && headers.origin !== 'http://127.0.0.1:3080') return 403
          return headers.cookie === 'fixture' ? undefined : 401
        },
      }),
    },
  })
  async function call(origin, id = 'conversation', cookie = 'fixture') {
    let status
    await handler({
      method: 'DELETE', headers: { host: '127.0.0.1:3080', origin, cookie },
      url: '/better-interface/session-delete?sessionId=' + encodeURIComponent(id),
    }, { writeHead: (code) => { status = code }, end() {} })
    return status
  }
  const origin = 'http://127.0.0.1:3080'
  assert.equal(await call('https://other.example'), 403)
  assert.equal(await call(undefined, 'conversation', ''), 401)
  assert.equal(await call(origin, '../conversation'), 400)
  state = 'archived'
  assert.equal(await call(origin), 409)
  assert.equal(opens, 0)
  live = false
  state = 'active'
  assert.equal(await call(origin), 409)
  state = 'hidden'
  assert.equal(await call(origin), 409)
  assert.equal(opens, 0)
  state = 'archived'
  restoreDuringOpen = true
  assert.equal(await call(origin), 409, 'a restore during deletion prevents the move')
  assert.equal(closes, 1)
  assert.equal(await readFile(record, 'utf8'), 'current')
  restoreDuringOpen = false
  nativeArchive = true
  assert.equal(await call(undefined), 200, 'desktop forwarding retains auth without an Origin header')
  assert.equal(closes, 2)
  await assert.rejects(readFile(record), { code: 'ENOENT' })
  assert.equal(await readFile(other, 'utf8'), 'another conversation')
  const trash = join(fixture, 'better-interface-trash')
  const [entry] = await readdir(trash)
  assert.equal(await readFile(join(trash, entry, 'session', 'session.jsonl.zstd'), 'utf8'), 'current')
  assert.equal(await readFile(join(trash, entry, 'session', 'older.jsonl.zstd'), 'utf8'), 'older')
  assert.deepEqual(JSON.parse(await readFile(join(trash, entry, 'restore.json'))), { originalPath: folder })
})
