import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { makeDeleteHandler } from './lib/host/delete-handler.js'

test('only a cold, same-origin session is moved, including all its log generations', async (t) => {
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
  let opens = 0
  let closes = 0
  const handler = makeDeleteHandler({
    sessions: { get: () => live ? {} : undefined },
    persistence: {
      async open(id, mode) {
        assert.equal(id, 'conversation')
        assert.equal(mode, 'write')
        opens++
        return { header: { id }, close: async () => { closes++ } }
      },
      locate: () => ({ kind: 'jsonl', path: record }),
    },
    ctx: {},
  })
  async function call(origin, id = 'conversation') {
    let status
    await handler({
      method: 'DELETE', headers: { host: '127.0.0.1:3080', origin },
      url: '/better-interface/session-delete?sessionId=' + encodeURIComponent(id),
    }, { writeHead: (code) => { status = code }, end() {} })
    return status
  }
  const origin = 'http://127.0.0.1:3080'
  assert.equal(await call('https://other.example'), 403)
  assert.equal(await call(origin, '../conversation'), 400)
  assert.equal(await call(origin), 409)
  assert.equal(opens, 0)
  live = false
  assert.equal(await call(origin), 200)
  assert.equal(closes, 1)
  await assert.rejects(readFile(record), { code: 'ENOENT' })
  assert.equal(await readFile(other, 'utf8'), 'another conversation')
  const trash = join(fixture, 'better-interface-trash')
  const [entry] = await readdir(trash)
  assert.equal(await readFile(join(trash, entry, 'session', 'session.jsonl.zstd'), 'utf8'), 'current')
  assert.equal(await readFile(join(trash, entry, 'session', 'older.jsonl.zstd'), 'utf8'), 'older')
  assert.deepEqual(JSON.parse(await readFile(join(trash, entry, 'restore.json'))), { originalPath: folder })
})
