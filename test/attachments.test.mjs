'use strict'

/**
 * Contract tests for this fork's one behavioural difference: `attachments` is a
 * mirror group.
 *
 * Everything runs against a temporary `$DSH_HOME` and a local "remote" directory
 * standing in for the GitHub tree, so nothing here touches the network, a real
 * installation or a real repository. The end-to-end case exercises the whole
 * path a restored session takes: plan → repository paths → restore → bytes on
 * disk, including the guards that keep a bad blob out of the store.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import zlib from 'node:zlib'

import { isExcludedAttachmentPath, attachmentDigestOf, isExcludedSessionFile } from '../src/paths.js'
import {
  GROUPS,
  buildPlan,
  mapRepoPathToLive,
  mapLivePathToRepo,
  fileMissingOnPurpose,
  invalidAttachmentReason,
  restoreFrom,
  localSource,
} from '../src/sync.js'
import { parseSimpleYamlSection, readLegacySettings } from '../src/legacy.js'

const INSTANCE = 'testbox-1234'

/** A fresh `$DSH_HOME`-shaped directory per test. */
async function tempHome() {
  return fsp.mkdtemp(join(os.tmpdir(), 'dshgs-att-'))
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

/**
 * Populate a home with one attachment store (two live images, one staged temp
 * file, one non-image file with its alias) and one session log.
 */
async function seedHome(home) {
  const store = join(home, 'attachments', 'v1')
  const images = {
    first: Buffer.from('first-image-bytes'),
    second: Buffer.from('second-image-bytes'),
  }
  for (const [name, bytes] of Object.entries(images)) {
    const hex = sha256(bytes)
    const dir = join(store, 'objects', hex.slice(0, 2))
    await fsp.mkdir(dir, { recursive: true })
    // Published objects are chmod 0o400 by the harness attachment store.
    await fsp.writeFile(join(dir, hex), bytes, { mode: 0o400 })
    images[name] = { bytes, hex, path: join(dir, hex) }
  }
  const fileBytes = Buffer.from('a pdf-ish attachment')
  const fileHex = sha256(fileBytes)
  await fsp.mkdir(join(store, 'file-objects', fileHex.slice(0, 2)), { recursive: true })
  await fsp.writeFile(join(store, 'file-objects', fileHex.slice(0, 2), fileHex), fileBytes, { mode: 0o400 })
  await fsp.mkdir(join(store, 'files', fileHex.slice(0, 2), fileHex), { recursive: true })
  await fsp.writeFile(join(store, 'files', fileHex.slice(0, 2), fileHex, 'report.pdf'), fileBytes, { mode: 0o400 })
  // A user attachment that happens to be named `tmp`: real data, and the one
  // case a naive name-anywhere exclusion rule would silently drop.
  const trapBytes = Buffer.from('an attachment literally named tmp')
  const trapHex = sha256(trapBytes)
  await fsp.mkdir(join(store, 'file-objects', trapHex.slice(0, 2)), { recursive: true })
  await fsp.writeFile(join(store, 'file-objects', trapHex.slice(0, 2), trapHex), trapBytes, { mode: 0o400 })
  await fsp.mkdir(join(store, 'files', trapHex.slice(0, 2), trapHex), { recursive: true })
  await fsp.writeFile(join(store, 'files', trapHex.slice(0, 2), trapHex, 'tmp'), trapBytes, { mode: 0o400 })
  // In-flight staging file: must never be mirrored.
  await fsp.mkdir(join(store, 'tmp'), { recursive: true })
  await fsp.writeFile(join(store, 'tmp', 'half-written'), Buffer.from('partial'))
  // Request-time normalization cache: named after a variant *identity*, not the
  // bytes, and rebuilt on demand — must never be mirrored either.
  const variantId = sha256('variant-identity-not-content')
  await fsp.mkdir(join(store, 'request-images', variantId.slice(0, 2)), { recursive: true })
  await fsp.writeFile(join(store, 'request-images', variantId.slice(0, 2), variantId), Buffer.from('normalized-bytes'), { mode: 0o600 })
  await fsp.writeFile(join(store, 'request-images', variantId.slice(0, 2), `${variantId}.abc.tmp`), Buffer.from('partial cache write'), { mode: 0o600 })

  const workspace = join(home, 'sessions', '--home-me-proj--', 'session-aaaa')
  await fsp.mkdir(workspace, { recursive: true })
  const log = zlib.zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'session', id: 'session-aaaa' })}\n`))
  await fsp.writeFile(join(workspace, 'session.v3.jsonl.zstd'), log)
  await fsp.writeFile(join(workspace, 'session.lock'), '')
  return { store, images, fileBytes, fileHex, workspace, log }
}

test('the attachments group is declared ahead of the groups that depend on it', () => {
  assert.deepEqual(GROUPS, ['sessions', 'attachments', 'plugins', 'settings'])
})

test('store scratch paths are excluded, durable ones are not', () => {
  assert.equal(isExcludedAttachmentPath('v1/tmp/abcdef'), true)
  assert.equal(isExcludedAttachmentPath('v1/objects/ab/cd.tmp'), true)
  assert.equal(isExcludedAttachmentPath('v1/.dsh-mkdir-xyz'), true)
  assert.equal(isExcludedAttachmentPath('v1/objects/ab/cd'), false)
  assert.equal(isExcludedAttachmentPath('v1/files/ab/cd/report.pdf'), false)
  // Derived request-image cache: not durable state, rebuildable on demand.
  assert.equal(isExcludedAttachmentPath(`v1/request-images/ab/${'a'.repeat(64)}`), true)
  assert.equal(isExcludedAttachmentPath(`v1/request-images/ab/${'a'.repeat(64)}.xyz.tmp`), true)
  // …but only in the bucket slot: an attachment a user named `tmp` is real data.
  assert.equal(isExcludedAttachmentPath(`v1/files/ab/${'a'.repeat(64)}/tmp`), false)
  assert.equal(isExcludedAttachmentPath(`v1/files/ab/${'a'.repeat(64)}/request-images`), false)
  assert.equal(isExcludedAttachmentPath('v1/objects/tmp/abc'), false, 'only the store bucket chooses the tree')
  // The session exclusion set must not have been widened by this fork.
  assert.equal(isExcludedSessionFile('session.v3.jsonl.zstd'), false)
  assert.equal(isExcludedSessionFile('session.lock'), true)
})

test('a content-addressed store path yields its promised digest', () => {
  const hex = 'a'.repeat(64)
  assert.equal(attachmentDigestOf(`v1/objects/aa/${hex}`), hex)
  assert.equal(attachmentDigestOf(`v1/file-objects/aa/${hex}`), hex)
  assert.equal(attachmentDigestOf(`v1/files/aa/${hex}/report.pdf`), hex)
  assert.equal(attachmentDigestOf('v1/tmp/whatever'), undefined)
  assert.equal(attachmentDigestOf(`v1/files/aa/${hex}`), undefined, 'an alias without its name is not addressed')
  assert.equal(attachmentDigestOf('v1/objects/aa/nothex'), undefined)
})

test('buildPlan mirrors the attachment store and skips its staging directory', async () => {
  const home = await tempHome()
  const { images, fileBytes } = await seedHome(home)
  const plan = await buildPlan({ home, instanceId: INSTANCE, groups: { sessions: true, attachments: true } })
  const paths = plan.files.map((f) => f.repoPath)

  assert.ok(paths.includes(`instances/${INSTANCE}/attachments/v1/objects/${images.first.hex.slice(0, 2)}/${images.first.hex}`))
  assert.ok(paths.includes(`instances/${INSTANCE}/attachments/v1/file-objects/${sha256(fileBytes).slice(0, 2)}/${sha256(fileBytes)}`))
  assert.ok(paths.includes(`instances/${INSTANCE}/attachments/v1/files/${sha256(fileBytes).slice(0, 2)}/${sha256(fileBytes)}/report.pdf`))
  assert.equal(paths.some((p) => p.includes('/tmp/')), false, 'staging files must not be uploaded')
  assert.equal(paths.some((p) => p.includes('/request-images/')), false, 'the derived cache must not be uploaded')
  assert.ok(paths.some((p) => p.endsWith('/tmp')), 'an attachment named tmp is real data and must travel')
  assert.equal(plan.totals.attachments, 6)
  assert.ok(plan.totals.attachmentsBytes > 0)

  const off = await buildPlan({ home, instanceId: INSTANCE, groups: { sessions: true, attachments: false } })
  assert.equal(off.totals.attachments, 0)
  assert.equal(off.files.some((f) => f.group === 'attachments'), false)
})

test('repository paths round-trip back to the same live files', async () => {
  const home = await tempHome()
  const { images } = await seedHome(home)
  const plan = await buildPlan({ home, instanceId: INSTANCE, groups: { sessions: true, attachments: true } })

  for (const file of plan.files) {
    const live = mapRepoPathToLive(file.repoPath, home)
    assert.ok(live, `unmapped repository path: ${file.repoPath}`)
    assert.equal(live.abs, file.abs)
    assert.equal(mapLivePathToRepo(file.abs, { home, instanceId: INSTANCE }), file.repoPath)
  }
  assert.equal(mapRepoPathToLive(`instances/${INSTANCE}/attachments/v1/objects/aa/${images.first.hex}`, home).group, 'attachments')
})

test('a group that is switched off never deletes the remote copy', async () => {
  const home = await tempHome()
  await seedHome(home)
  const withAttachments = await buildPlan({ home, instanceId: INSTANCE, groups: { sessions: true, attachments: false } })
  const remoteObject = `instances/${INSTANCE}/attachments/v1/objects/aa/bb`
  assert.equal(fileMissingOnPurpose(remoteObject, withAttachments, []), false, 'attachments off => keep them on the remote')

  const withoutAttachmentsInPlan = await buildPlan({ home, instanceId: INSTANCE, groups: { sessions: true, attachments: true } })
  assert.equal(fileMissingOnPurpose(remoteObject, withoutAttachmentsInPlan, []), true, 'attachments on but file gone locally => real deletion')
  assert.equal(fileMissingOnPurpose('instances/other-machine/attachments/v1/objects/aa/bb', withoutAttachmentsInPlan, []), true)
})

test('a blob whose bytes do not match its path digest is refused', async () => {
  const home = await tempHome()
  const { images } = await seedHome(home)
  const good = `instances/${INSTANCE}/attachments/v1/objects/${images.first.hex.slice(0, 2)}/${images.first.hex}`
  assert.equal(invalidAttachmentReason(good, images.first.bytes), null)
  const truncated = images.first.bytes.subarray(0, 4)
  assert.match(invalidAttachmentReason(good, truncated), /sha256/)
  // Non-store paths are never judged by this guard.
  assert.equal(invalidAttachmentReason(`instances/${INSTANCE}/sessions/x/y/session.v3.jsonl.zstd`, truncated), null)
})

test('plan → repository → restore reproduces the store byte for byte', async () => {
  const source = await tempHome()
  const { images, fileBytes, log } = await seedHome(source)

  // The plan is the single source of truth for what a push would upload, so
  // materializing it into a directory is a faithful stand-in for the remote.
  const repo = await tempHome()
  const plan = await buildPlan({ home: source, instanceId: INSTANCE, groups: { sessions: true, attachments: true } })
  for (const file of plan.files) {
    const target = join(repo, ...file.repoPath.split('/'))
    await fsp.mkdir(dirname(target), { recursive: true })
    await fsp.copyFile(file.abs, target)
  }

  const target = await tempHome()
  const result = await restoreFrom({ source: localSource(repo), home: target, only: { instanceId: INSTANCE } })
  assert.equal(result.skipped.length, 0, JSON.stringify(result.skipped))

  for (const image of [images.first, images.second]) {
    const restored = join(target, 'attachments', 'v1', 'objects', image.hex.slice(0, 2), image.hex)
    assert.deepEqual(await fsp.readFile(restored), image.bytes)
    const stat = await fsp.stat(restored)
    assert.equal(stat.mode & 0o777, 0o400, 'restored objects keep the store\'s read-only mode')
  }
  const alias = join(target, 'attachments', 'v1', 'files', sha256(fileBytes).slice(0, 2), sha256(fileBytes), 'report.pdf')
  assert.deepEqual(await fsp.readFile(alias), fileBytes)
  assert.deepEqual(await fsp.readFile(join(target, 'sessions', '--home-me-proj--', 'session-aaaa', 'session.v3.jsonl.zstd')), log)
  assert.equal(fs.existsSync(join(target, 'attachments', 'v1', 'tmp')), false, 'staging never travels')

  // A second run changes nothing.
  const again = await restoreFrom({ source: localSource(repo), home: target, only: { instanceId: INSTANCE } })
  assert.equal(again.written.length, 0)
  assert.equal(again.unchanged.length, plan.files.length)
})

test('a corrupted backup blob is skipped instead of poisoning the store', async () => {
  const source = await tempHome()
  const { images } = await seedHome(source)
  const repo = await tempHome()
  const plan = await buildPlan({ home: source, instanceId: INSTANCE, groups: { attachments: true } })
  for (const file of plan.files) {
    const target = join(repo, ...file.repoPath.split('/'))
    await fsp.mkdir(dirname(target), { recursive: true })
    await fsp.copyFile(file.abs, target)
  }
  const victim = join(repo, 'instances', INSTANCE, 'attachments', 'v1', 'objects', images.first.hex.slice(0, 2), images.first.hex)
  // The store (and therefore the copy) is read-only; tamper explicitly.
  await fsp.chmod(victim, 0o644)
  await fsp.writeFile(victim, Buffer.from('tampered'))

  const target = await tempHome()
  const result = await restoreFrom({ source: localSource(repo), home: target, only: { instanceId: INSTANCE, groups: ['attachments'] } })
  const stored = plan.files.filter((f) => f.group === 'attachments').length
  assert.equal(result.written.length, stored - 1, 'every good object lands, the tampered one does not')
  assert.equal(result.skipped.length, 1)
  assert.match(result.skipped[0].reason, /附件校验失败/)
  assert.equal(fs.existsSync(join(target, 'attachments', 'v1', 'objects', images.first.hex.slice(0, 2), images.first.hex)), false)
})

test('the group filter restores attachments without re-writing sessions', async () => {
  const source = await tempHome()
  await seedHome(source)
  const repo = await tempHome()
  const plan = await buildPlan({ home: source, instanceId: INSTANCE, groups: { sessions: true, attachments: true } })
  for (const file of plan.files) {
    const target = join(repo, ...file.repoPath.split('/'))
    await fsp.mkdir(dirname(target), { recursive: true })
    await fsp.copyFile(file.abs, target)
  }
  const target = await tempHome()
  const result = await restoreFrom({ source: localSource(repo), home: target, only: { instanceId: INSTANCE, groups: ['attachments'] } })
  assert.ok(result.written.length > 0)
  assert.equal(fs.existsSync(join(target, 'sessions')), false, 'sessions were filtered out')
})

test('the original plugin\'s settings are recovered for the first run', async () => {
  const home = await tempHome()
  await fsp.writeFile(
    join(home, 'settings.yaml'),
    [
      'ui-onboarding:',
      '  welcomeNoticeVersion: 2026-08-13.1',
      'dsh-github-sync:',
      '  repoUrl: https://github.com/me/private-backup',
      '  branch: backup',
      '  token: test-token-example',
      '  syncSessions: true',
      '  syncSettings: false',
      '  maxFileMb: 60',
      '  excludeWorkspaces: "--a--,--b--"',
      'locale:',
      '  preference: zh',
      '',
    ].join('\n'),
  )
  const yaml = parseSimpleYamlSection(fs.readFileSync(join(home, 'settings.yaml'), 'utf8'), 'dsh-github-sync')
  assert.equal(yaml.repoUrl, 'https://github.com/me/private-backup')
  assert.equal(yaml.branch, 'backup')
  assert.equal(yaml.syncSessions, true)
  assert.equal(yaml.syncSettings, false)
  assert.equal(yaml.maxFileMb, 60)
  assert.equal(yaml.excludeWorkspaces, '--a--,--b--')
  assert.equal(yaml['preference'], undefined, 'the next top-level key does not leak in')

  const settings = readLegacySettings({
    home,
    booleans: new Set(['syncSessions', 'syncSettings']),
    numbers: new Set(['maxFileMb']),
    strings: new Set(['repoUrl', 'branch', 'excludeWorkspaces']),
  })
  assert.equal(settings.repoUrl, 'https://github.com/me/private-backup')
  assert.equal(settings.token, 'test-token-example')
  assert.equal(settings.maxFileMb, 60)

  // The plugin's own fallback file wins where both define a key.
  await fsp.mkdir(join(home, 'dsh-github-sync'), { recursive: true })
  await fsp.writeFile(join(home, 'dsh-github-sync', 'config.json'), JSON.stringify({ repoUrl: 'me/from-json', token: 'test-token-json' }))
  const merged = readLegacySettings({
    home,
    booleans: new Set(['syncSessions']),
    numbers: new Set(['maxFileMb']),
    strings: new Set(['repoUrl', 'branch']),
  })
  assert.equal(merged.repoUrl, 'me/from-json')
  assert.equal(merged.token, 'test-token-json')
  assert.equal(merged.branch, 'backup', 'values only the YAML layer has survive')
})

test('a settings.yaml without the section, or a malformed one, yields nothing', async () => {
  const home = await tempHome()
  await fsp.writeFile(join(home, 'settings.yaml'), 'locale:\n  preference: zh\n')
  assert.deepEqual(parseSimpleYamlSection(fs.readFileSync(join(home, 'settings.yaml'), 'utf8'), 'dsh-github-sync'), {})
  assert.deepEqual(readLegacySettings({ home }), {})

  const weird = ['dsh-github-sync:', '  repoUrl: &anchor value', '  token: >', '  branch: "unterminated'].join('\n')
  const parsed = parseSimpleYamlSection(weird, 'dsh-github-sync')
  assert.deepEqual(parsed, {}, 'unsupported YAML shapes are skipped, never guessed')
})
