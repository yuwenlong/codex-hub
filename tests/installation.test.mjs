import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const legacyStatusLine = [
  'model-with-reasoning', 'project-name', 'git-branch', 'context-used',
  'five-hour-limit', 'weekly-limit', 'task-progress',
]

async function fixture(t, statusLine = null) {
  const home = await mkdtemp(join(tmpdir(), 'codex-hud config with spaces '))
  t.after(() => rm(home, { force: true, recursive: true }))
  const config = { tui: { theme: 'default' } }
  if (statusLine !== null) config.tui.status_line = statusLine
  let version = 0
  const client = {
    async request(method, params) {
      const file = join(home, 'config.toml')
      if (method === 'config/read') {
        assert.equal(params.includeLayers, true)
        return {
          config: structuredClone(config),
          layers: [{ name: { type: 'user', file }, version: String(version), config: structuredClone(config) }],
        }
      }
      assert.equal(method, 'config/value/write')
      assert.equal(params.filePath, file)
      assert.equal(params.keyPath, 'tui.status_line')
      assert.equal(params.mergeStrategy, 'replace')
      assert.equal(params.expectedVersion, String(version))
      version += 1
      if (params.value === null) delete config.tui.status_line
      else config.tui.status_line = params.value
      return { status: 'ok', filePath: file, version: String(version) }
    },
  }
  return { client, home, config }
}

async function legacyBackup(home, original, { pending } = {}) {
  const path = join(home, 'codex-hud-statusline.json')
  const raw = JSON.stringify({ version: 1, original, applied: legacyStatusLine, pending }, null, 2) + '\n'
  await writeFile(path, raw)
  return { path, raw }
}

test('restores the original footer after repeated installs', async t => {
  const { STATUS_LINE, doctor, install, uninstall } = await import('../lib/installation.mjs')
  const { client, home, config } = await fixture(t, ['model', 'context-remaining'])
  assert.equal((await doctor(client, home)).installed, false)
  assert.equal((await install(client, home)).changed, true)
  assert.deepEqual(config.tui.status_line, STATUS_LINE)
  for (const field of ['five-hour-limit', 'codex-version', 'total-input-tokens', 'total-output-tokens', 'estimated-thread-cost']) {
    assert.ok(config.tui.status_line.includes(field), `missing default field ${field}`)
  }
  assert.equal((await doctor(client, home)).installed, true)
  assert.equal((await install(client, home)).changed, false)
  config.tui.theme = 'custom'
  assert.equal((await uninstall(client, home)).changed, true)
  assert.deepEqual(config.tui, { theme: 'custom', status_line: ['model', 'context-remaining'] })
  assert.equal((await doctor(client, home)).installed, false)
})

test('removes a footer key that was absent before installation', async t => {
  const { install, uninstall } = await import('../lib/installation.mjs')
  const { client, home, config } = await fixture(t)
  await install(client, home)
  await uninstall(client, home)
  assert.deepEqual(config.tui, { theme: 'default' })
})

test('recognizes a matching manually configured footer and preserves it on uninstall', async t => {
  const { STATUS_LINE, doctor, install, uninstall } = await import('../lib/installation.mjs')
  const { client, home, config } = await fixture(t, [...STATUS_LINE])
  assert.equal((await install(client, home)).changed, false)
  assert.equal((await doctor(client, home)).installed, true)
  assert.equal((await uninstall(client, home)).changed, false)
  assert.deepEqual(config.tui.status_line, STATUS_LINE)
})

test('uninstall preserves footer edits made after installation', async t => {
  const { install, uninstall } = await import('../lib/installation.mjs')
  const { client, home, config } = await fixture(t, ['model'])
  await install(client, home)
  config.tui.status_line = ['reasoning', 'project-name']
  assert.equal((await uninstall(client, home)).preserved, true)
  assert.deepEqual(config.tui.status_line, ['reasoning', 'project-name'])
  await install(client, home)
  await uninstall(client, home)
  assert.deepEqual(config.tui.status_line, ['reasoning', 'project-name'])
})

test('a manual upgrade from the old preset retains an originally absent status line', async t => {
  const { install, uninstall } = await import('../lib/installation.mjs')
  const { client, home, config } = await fixture(t, legacyStatusLine)
  await legacyBackup(home, null)

  assert.equal((await install(client, home)).changed, true)
  assert.ok(config.tui.status_line.includes('codex-version'))
  assert.equal((await uninstall(client, home)).changed, true)
  assert.deepEqual(config.tui, { theme: 'default' })
})

test('an old backup does not grant ownership over a subsequently edited footer', async t => {
  const { install } = await import('../lib/installation.mjs')
  const custom = ['reasoning', 'project-name']
  const { client, home, config } = await fixture(t, custom)
  const { path, raw } = await legacyBackup(home, ['model'])

  assert.equal((await install(client, home)).changed, false)
  assert.deepEqual(config.tui.status_line, custom)
  assert.equal(await readFile(path, 'utf8'), raw)
})

test('a failed runtime publication leaves the old backup untouched', async t => {
  const { install, uninstall } = await import('../lib/installation.mjs')
  const { client, home, config } = await fixture(t, legacyStatusLine)
  const { path, raw } = await legacyBackup(home, ['model'])

  await assert.rejects(install(client, home, { upgrade: true, publish() { throw new Error('publication failed') } }), /publication failed/u)
  assert.deepEqual(config.tui.status_line, legacyStatusLine)
  assert.equal(await readFile(path, 'utf8'), raw)
  await uninstall(client, home)
  assert.deepEqual(config.tui.status_line, ['model'])
})

test('upgrading a pending old install preserves its earliest backup', async t => {
  const { install, uninstall } = await import('../lib/installation.mjs')
  const { client, home, config } = await fixture(t, ['model'])
  await legacyBackup(home, ['model'], { pending: true })

  assert.equal((await install(client, home, { upgrade: true, publish() {} })).changed, true)
  assert.ok(config.tui.status_line.includes('codex-version'))
  await uninstall(client, home)
  assert.deepEqual(config.tui.status_line, ['model'])
})

test('uninstall retains the original footer after an upgrade write times out after applying', async t => {
  const { install, uninstall } = await import('../lib/installation.mjs')
  const { client, home, config } = await fixture(t, legacyStatusLine)
  await legacyBackup(home, ['model'])
  const request = client.request
  client.request = async (method, params) => {
    const result = await request(method, params)
    if (method === 'config/value/write') throw new Error('timed out')
    return result
  }

  await assert.rejects(install(client, home, { upgrade: true, publish() {} }), /timed out/u)
  assert.ok(config.tui.status_line.includes('codex-version'))
  client.request = request
  assert.equal((await uninstall(client, home)).changed, true)
  assert.deepEqual(config.tui.status_line, ['model'])
})

test('retains the original footer if the first write times out after applying', async t => {
  const { install, uninstall } = await import('../lib/installation.mjs')
  const { client, home, config } = await fixture(t, ['model'])
  const request = client.request
  client.request = async (method, params) => {
    const result = await request(method, params)
    if (method === 'config/value/write') throw new Error('timed out')
    return result
  }
  await assert.rejects(install(client, home), /timed out/u)
  client.request = request
  await uninstall(client, home)
  assert.deepEqual(config.tui.status_line, ['model'])
})

test('prevents uninstall from clearing the backup during install', async t => {
  const { install, uninstall } = await import('../lib/installation.mjs')
  const { client, home, config } = await fixture(t, ['model'])
  const writing = Promise.withResolvers()
  const release = Promise.withResolvers()
  const request = client.request
  client.request = async (method, params) => {
    if (method === 'config/value/write') {
      writing.resolve()
      await release.promise
    }
    return request(method, params)
  }
  const installation = install(client, home)
  await writing.promise
  try {
    await assert.rejects(uninstall(client, home), /in progress/u)
  } finally {
    release.resolve()
    await installation
  }
  await uninstall(client, home)
  assert.deepEqual(config.tui.status_line, ['model'])
})
