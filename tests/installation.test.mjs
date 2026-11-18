import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

async function fixture(t, statusLine = null) {
  const home = await mkdtemp(join(tmpdir(), 'codex-hub config with spaces '))
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

test('restores the original footer after repeated installs', async t => {
  const { STATUS_LINE, doctor, install, uninstall } = await import('../lib/installation.mjs')
  const { client, home, config } = await fixture(t, ['model', 'context-remaining'])
  assert.equal((await doctor(client, home)).installed, false)
  assert.equal((await install(client, home)).changed, true)
  assert.deepEqual(config.tui.status_line, STATUS_LINE)
  assert.ok(config.tui.status_line.includes('five-hour-limit'))
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
