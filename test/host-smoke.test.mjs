'use strict'

/**
 * Boot the real plugin entry point against a temporary `$DSH_HOME`.
 *
 * The unit tests prove the sync engine; this proves the plugin *composes*: the
 * exported `name`/`inject` contract, the route it registers, the settings the
 * client will read, and the two migrations that make installing the fork a
 * no-op for an existing backup (machine id and repository credentials).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

/** Minimal cordis context: captures the route, ignores the rest. */
function fakeCtx() {
  const routes = []
  const disposers = []
  const ctx = {
    logger: () => ({ info() {}, warn() {}, error() {} }),
    inject: () => {},
    effect: (fn) => {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer)
    },
    webServer: {
      register: (route) => {
        routes.push(route)
        return () => {}
      },
    },
  }
  return { ctx, routes, disposers }
}

/** Drive one request through a captured prefix route. */
async function request(route, path, { method = 'GET', headers = {}, body } = {}) {
  const listeners = new Map()
  const req = {
    url: path,
    method,
    headers,
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(handler)
      return this
    },
    destroy() {},
  }
  const emit = (event, value) => {
    for (const handler of listeners.get(event) || []) handler(value)
  }
  if (body !== undefined) {
    // readJsonBody subscribes before awaiting, so deliver after the handler starts.
    setImmediate(() => {
      emit('data', Buffer.from(JSON.stringify(body)))
      emit('end')
    })
  }
  let status = 0
  let text = ''
  const res = {
    writeHead: (code) => {
      status = code
    },
    end: (chunk) => {
      text = chunk
    },
  }
  await route.handler(req, res)
  return { status, json: text ? JSON.parse(text) : null }
}

async function prepareHome() {
  const home = await fsp.mkdtemp(join(os.tmpdir(), 'dshgs-host-'))
  // A previous install of the original plugin: settings + machine id.
  await fsp.writeFile(
    join(home, 'settings.yaml'),
    [
      'dsh-github-sync:',
      '  repoUrl: https://github.com/me/private-backup',
      '  branch: main',
      '  token: test-token-legacy',
      '  syncSessions: true',
      '  maxFileMb: 45',
      '',
    ].join('\n'),
  )
  await fsp.mkdir(join(home, 'dsh-github-sync'), { recursive: true })
  await fsp.writeFile(join(home, 'dsh-github-sync', 'state.json'), JSON.stringify({ instanceId: 'source-box-7f3c', history: [] }))

  // An attachment store with two objects and one staging file.
  const store = join(home, 'attachments', 'v1')
  for (const bytes of [Buffer.from('one'), Buffer.from('two')]) {
    const hex = createHash('sha256').update(bytes).digest('hex')
    await fsp.mkdir(join(store, 'objects', hex.slice(0, 2)), { recursive: true })
    await fsp.writeFile(join(store, 'objects', hex.slice(0, 2), hex), bytes, { mode: 0o444 })
  }
  await fsp.mkdir(join(store, 'tmp'), { recursive: true })
  await fsp.writeFile(join(store, 'tmp', 'staged'), 'partial')

  // A workspace with one session, so the session inventory has something to count.
  await fsp.mkdir(join(home, 'sessions', '--nonexistent-workspace--', 'session-1'), { recursive: true })
  await fsp.writeFile(join(home, 'sessions', '--nonexistent-workspace--', 'session-1', 'session.v3.jsonl.zstd'), Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0, 0]))
  return home
}

test('the fork boots, keeps its own identity, and adopts the old backup', async () => {
  const home = await prepareHome()
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const mod = await import('../src/index.js')
    assert.equal(mod.name, 'dsh-github-sync-with-attachments')
    assert.deepEqual(mod.inject, ['webServer'])

    const { ctx, routes } = fakeCtx()
    mod.apply(ctx, {})
    assert.equal(routes.length, 1)
    assert.equal(routes[0].kind, 'prefix')
    assert.equal(routes[0].path, '/dsh-github-sync-with-attachments/api')

    const status = await request(routes[0], '/dsh-github-sync-with-attachments/api/status')
    assert.equal(status.status, 200)
    assert.equal(status.json.api, 5)
    assert.equal(status.json.version, '0.5.0')

    // The fork's own state directory holds the adopted machine id, so the
    // repository keeps one instances/<id>/ tree instead of orphaning the old one.
    assert.equal(status.json.instanceId, 'source-box-7f3c')
    const state = JSON.parse(await fsp.readFile(join(home, 'dsh-github-sync-with-attachments', 'state.json'), 'utf8'))
    assert.equal(state.instanceId, 'source-box-7f3c')

    // Credentials carried over from the original plugin's settings namespace.
    assert.equal(status.json.settings.repoUrl, 'https://github.com/me/private-backup')
    assert.equal(status.json.settings.hasToken, true)
    assert.equal(status.json.configured, true)
    assert.equal(status.json.settings.token, undefined, 'the token is never echoed')

    // The new group defaults on, and the store is counted for the UI.
    assert.equal(status.json.settings.syncAttachments, true)
    assert.equal(status.json.local.attachments.files, 2, 'staging files are not counted')
    assert.equal(status.json.local.attachments.bytes, 6)
    assert.equal(status.json.local.sessions.sessionCount, 1)

    // The original plugin's directory is untouched.
    assert.equal(JSON.parse(await fsp.readFile(join(home, 'dsh-github-sync', 'state.json'), 'utf8')).instanceId, 'source-box-7f3c')
    assert.equal(fs.existsSync(join(home, 'settings.yaml')), true)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('the attachments toggle round-trips through the settings route', async () => {
  const home = await prepareHome()
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const mod = await import('../src/index.js')
    const { ctx, routes } = fakeCtx()
    mod.apply(ctx, {})
    const put = await request(routes[0], '/dsh-github-sync-with-attachments/api/settings', {
      method: 'PUT',
      headers: { host: '127.0.0.1:3080' },
      body: { syncAttachments: false, maxFileMb: 12 },
    })
    assert.equal(put.status, 200)
    assert.equal(put.json.settings.syncAttachments, false)
    assert.equal(put.json.settings.maxFileMb, 12)

    const status = await request(routes[0], '/dsh-github-sync-with-attachments/api/status')
    assert.equal(status.json.settings.syncAttachments, false)
    // The new key is validated like every other boolean, and no token is echoed.
    assert.equal(status.json.settings.token, undefined)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('a machine with no attachments directory still reports zero, not a failure', async () => {
  const home = await fsp.mkdtemp(join(os.tmpdir(), 'dshgs-empty-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const mod = await import('../src/index.js')
    const { ctx, routes } = fakeCtx()
    mod.apply(ctx, {})
    const status = await request(routes[0], '/dsh-github-sync-with-attachments/api/status')
    assert.equal(status.status, 200)
    assert.deepEqual(status.json.local.attachments.files, 0)
    assert.deepEqual(status.json.local.attachments.bytes, 0)
    assert.equal(status.json.configured, false)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('the client bundle loads through the shell\'s module loader', async () => {
  const loaded = []
  const requireShim = (specifier) => {
    if (specifier === 'react') {
      const createElement = (type, props, ...children) => ({ type, props, children })
      return { createElement, Fragment: Symbol('Fragment'), useState: (v) => [v, () => {}], useEffect: () => {}, useMemo: (f) => f(), useCallback: (f) => f }
    }
    throw new Error(`unexpected require: ${specifier}`)
  }
  globalThis.window = globalThis.window || {}
  globalThis.window.__ModuleLoader__ = {
    load: ({ id, factory }) => {
      loaded.push({ id, exports: factory(requireShim) })
    },
  }
  const bundle = await fsp.readFile(new URL('../client/bundle.js', import.meta.url), 'utf8')
  // eslint-disable-next-line no-new-func
  new Function(bundle)()
  assert.equal(loaded.length, 1)
  assert.equal(loaded[0].id, 'dsh-github-sync-with-attachments')
  const plugin = loaded[0].exports.default || loaded[0].exports
  assert.equal(typeof plugin.apply, 'function')
  assert.ok(plugin.name, 'the client half declares a name')
})
