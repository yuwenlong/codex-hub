import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const server = String.raw`
const { createReadStream, writeSync } = require('node:fs')
const readline = require('node:readline')
let initialized = false
let capabilities = null
function reply(response) {
  writeSync(1, JSON.stringify(response) + '\r\n')
}
readline.createInterface({input: createReadStream(null, { fd: 0 })}).on('line', line => {
  const message = JSON.parse(line)
  const { id, method, params } = message
  if (method === 'initialize') {
    if (params.clientInfo.name !== 'codex_hud') process.exit(2)
    capabilities = params.capabilities ?? null
    reply({ id, result: { userAgent: 'codex_hud/0.170.0 (Fixture OS) fixture (codex_hud; 0.1.2)' } })
  } else if (method === 'initialized') {
    initialized = true
  } else if (!initialized) {
    process.exit(3)
  } else if (method === 'check') {
    reply({ method: 'thread/status/changed', params: { id } })
    setTimeout(() => reply({ id, result: { params, args: process.argv.slice(2) } }), params.delay)
  } else if (method === 'failure') {
    reply({ id, error: { code: -32600, message: '\u001b[31mnot ready\u001b[0m' } })
  } else if (method === 'capabilities') {
    reply({ id, result: capabilities })
  }
})
`

async function fixture(t, { experimentalApi = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'codex-hud path with spaces '))
  let client
  t.after(async () => {
    await client?.close()
    await rm(directory, { force: true, recursive: true })
  })
  const env = { ...process.env, PATH: directory }
  if (process.platform === 'win32') {
    const bin = join(directory, 'node_modules', '@openai', 'codex', 'bin')
    await mkdir(bin, { recursive: true })
    await writeFile(join(directory, 'codex.cmd'), '@exit /b 17\r\n')
    await writeFile(join(bin, 'codex.js'), server)
  } else {
    const script = join(directory, 'app-server.cjs')
    const executable = join(directory, 'codex')
    await writeFile(script, server)
    await writeFile(executable, '#!/bin/sh\nexec "$CODEX_HUD_TEST_NODE" "$CODEX_HUD_TEST_SERVER" "$@"\n')
    await chmod(executable, 0o700)
    env.CODEX_HUD_TEST_NODE = process.execPath
    env.CODEX_HUD_TEST_SERVER = script
  }
  const { openClient } = await import('../lib/app-server.mjs')
  client = await openClient({ cwd: directory, env, experimentalApi })
  return client
}

test('initializes over stdio and matches out-of-order replies', async t => {
  const client = await fixture(t)
  assert.equal(client.codexVersion, '0.170.0')
  assert.equal(await client.request('capabilities'), null)
  const replies = await Promise.all([
    client.request('check', { delay: 10 }),
    client.request('check', { delay: 0 }),
  ])
  assert.deepEqual(replies, [
    { params: { delay: 10 }, args: ['app-server', '--listen', 'stdio://'] },
    { params: { delay: 0 }, args: ['app-server', '--listen', 'stdio://'] },
  ])
  await assert.rejects(client.request('failure'), error => {
    assert.equal(error.code, -32600)
    assert.match(error.message, /not ready/u)
    assert.doesNotMatch(error.message, /\u001b/u)
    return true
  })
  const pending = client.request('hold')
  client.close()
  await assert.rejects(pending, /closed/u)
})

test('enables the experimental protocol only when requested', async t => {
  const client = await fixture(t, { experimentalApi: true })
  assert.deepEqual(await client.request('capabilities'), { experimentalApi: true })
})

test('an optional request can time out while the app server stays open', { timeout: 1500 }, async t => {
  const client = await fixture(t)
  await assert.rejects(client.request('hold', undefined, { timeoutMs: 20 }), /hold timed out/u)
  assert.equal(await client.request('capabilities'), null)
})

test('explains when Codex is unavailable', async t => {
  const { openClient } = await import('../lib/app-server.mjs')
  const directory = await mkdtemp(join(tmpdir(), 'codex-hud empty PATH '))
  t.after(() => rm(directory, { force: true, recursive: true }))
  await assert.rejects(
    openClient({ cwd: directory, env: { ...process.env, PATH: directory } }),
    /Codex CLI.*PATH/u,
  )
})
