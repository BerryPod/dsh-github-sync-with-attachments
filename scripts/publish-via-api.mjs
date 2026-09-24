#!/usr/bin/env node
'use strict'

/**
 * Publish the local `main` commit to GitHub through the REST API.
 *
 * Why this exists: on networks where `github.com:443` is blocked (a common
 * mainland-China failure mode — plain TLS to the git endpoint is reset while
 * `api.github.com` stays reachable), `git push` cannot work at all, and
 * `git@github.com:22` needs an SSH key registered on the account. The Git Data
 * API is served from `api.github.com`, so the very same commit can be
 * published without either.
 *
 * It reproduces the local commit *exactly*: same tree, same parents (none, for
 * a root commit), same message bytes, same author/committer identity and dates.
 * When the tree matches, GitHub computes the identical SHA-1 — so the script
 * verifies the result by comparing `git rev-parse HEAD` with the commit it
 * created, and fails loudly if they differ.
 *
 * Usage:
 *   GITHUB_TOKEN=... node scripts/publish-via-api.mjs [--repo owner/name] [--dry-run]
 *
 * Without GITHUB_TOKEN the token is read from the `dsh-github-sync` section of
 * `$DSH_HOME/settings.yaml` (the same file the sync plugin uses). The token is
 * never printed, never placed in argv, and never written anywhere.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback
}
const dryRun = args.includes('--dry-run')
const repo = flag('repo', process.env.GITHUB_REPO || 'BerryPod/dsh-github-sync-with-attachments')
const [owner, name] = repo.split('/')
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')

if (!owner || !name) {
  console.error(`无法解析仓库：${repo}`)
  process.exit(2)
}

// ── token ────────────────────────────────────────────────────────────────

function readToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN
  const home = process.env.DSH_HOME ? path.resolve(process.env.DSH_HOME) : path.join(os.homedir(), '.dsh')
  const file = path.join(home, 'settings.yaml')
  const text = fs.readFileSync(file, 'utf8')
  const section = text.split(/\r?\n/)
  let inside = false
  for (const line of section) {
    if (/^\S/.test(line)) {
      inside = line.trimEnd() === 'dsh-github-sync:'
      continue
    }
    if (!inside) continue
    const m = /^\s+token:\s*(\S+)\s*$/.exec(line)
    if (m) return m[1]
  }
  throw new Error(`在 ${file} 里找不到 dsh-github-sync.token，请改用 GITHUB_TOKEN=... 调用`)
}

const token = readToken()

async function api(method, endpoint, body) {
  const res = await fetch(`https://api.github.com${endpoint}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'dsh-publish-via-api',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok) {
    const message = (json && json.message) || text.slice(0, 200)
    const error = new Error(`${method} ${endpoint} → HTTP ${res.status}: ${message}`)
    error.status = res.status
    throw error
  }
  return json
}

// ── the local commit, read straight out of git ───────────────────────────

const git = (...gitArgs) => execFileSync('git', ['-C', root, ...gitArgs], { encoding: 'utf8' })
const head = git('rev-parse', 'HEAD').trim()
const localTree = git('rev-parse', 'HEAD^{tree}').trim()
const message = git('log', '-1', '--pretty=%B').replace(/\n+$/, '\n')
const meta = git('log', '-1', '--pretty=%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI').trim().split('\0')
const [authorName, authorEmail, authorDate, committerName, committerEmail, committerDate] = meta
const entries = git('ls-files', '-s', '-z')
  .split('\0')
  .filter(Boolean)
  .map((row) => {
    const [info, file] = row.split('\t')
    // `git ls-files -s` is `<mode> <object> <stage>\t<path>`; the third field is
    // the merge stage (always 0 here), not the blob id.
    const [mode, object, stage] = info.split(' ')
    if (!/^100(644|755)$/.test(mode) || !/^[0-9a-f]{40}$/.test(object) || !/^\d+$/.test(stage)) {
      throw new Error(`无法解析 git ls-files -s 的行：${row}`)
    }
    return { mode, sha: object, file }
  })

console.log(`仓库      : ${repo}`)
console.log(`本地提交  : ${head}  (tree ${localTree})`)
console.log(`作者/时间 : ${authorName} <${authorEmail}> @ ${authorDate}`)
console.log(`文件数    : ${entries.length}`)
if (dryRun) {
  console.log('\n--dry-run：不写入任何东西。')
  process.exit(0)
}

// The blob SHAs come from the commit, but the bytes come from the working tree,
// so an uncommitted edit would surface as a confusing "blob 摘要不一致". Say it
// plainly instead.
const dirty = git('status', '--porcelain').trim()
if (dirty !== '') {
  console.error(`工作区有未提交的改动，请先提交再发布：\n${dirty}`)
  process.exit(2)
}

// ── 1. an empty repository rejects the Git Data API (409) ────────────────

let empty = false
try {
  await api('GET', `/repos/${owner}/${name}/git/ref/heads/${'main'}`)
} catch (error) {
  if (error.status === 404 || error.status === 409) empty = true
  else throw error
}

if (empty) {
  const seedPath = entries.find((e) => e.file === 'README.md') ? 'README.md' : entries[0].file
  const seed = entries.find((e) => e.file === seedPath)
  const content = fs.readFileSync(path.join(root, seedPath))
  console.log(`空仓库：先用 Contents API 写入 ${seedPath} 作为种子提交…`)
  await api('PUT', `/repos/${owner}/${name}/contents/${encodeURIComponent(seedPath)}`, {
    message: 'chore: 初始化仓库',
    content: content.toString('base64'),
    branch: 'main',
  })
  console.log(`  种子提交的 blob sha = ${seed.sha}（应与本地一致）`)
}

// ── 2. blobs → tree → commit ─────────────────────────────────────────────

console.log('上传 blob…')
const tree = []
for (const entry of entries) {
  const content = fs.readFileSync(path.join(root, entry.file))
  const blob = await api('POST', `/repos/${owner}/${name}/git/blobs`, {
    content: content.toString('base64'),
    encoding: 'base64',
  })
  if (blob.sha !== entry.sha) {
    throw new Error(`blob 摘要不一致：${entry.file}\n  本地 ${entry.sha}\n  远端 ${blob.sha}`)
  }
  tree.push({ path: entry.file, mode: entry.mode, type: 'blob', sha: blob.sha })
  console.log(`  ✔ ${entry.file}`)
}

console.log('创建 tree…')
const created = await api('POST', `/repos/${owner}/${name}/git/trees`, { tree })
if (created.sha !== localTree) {
  throw new Error(`tree 摘要不一致：本地 ${localTree}，远端 ${created.sha}`)
}

console.log('创建 commit（无父提交，与本地根提交一致）…')
const commit = await api('POST', `/repos/${owner}/${name}/git/commits`, {
  message,
  tree: created.sha,
  parents: [],
  author: { name: authorName, email: authorEmail, date: authorDate },
  committer: { name: committerName, email: committerEmail, date: committerDate },
})

console.log('更新 refs/heads/main…')
await api('PATCH', `/repos/${owner}/${name}/git/refs/heads/main`, { sha: commit.sha, force: true })

if (commit.sha !== head) {
  throw new Error(`commit 摘要不一致：本地 ${head}，远端 ${commit.sha}（内容已推送，但历史标识不同）`)
}

// ── 3. verify by reading the remote back ─────────────────────────────────

const remoteTree = await api('GET', `/repos/${owner}/${name}/git/trees/${commit.sha}?recursive=1`)
const remote = remoteTree.tree.filter((e) => e.type === 'blob').map((e) => `${e.mode} ${e.sha}\t${e.path}`).sort()
const local = entries.map((e) => `${e.mode} ${e.sha}\t${e.file}`).sort()
const same = remote.length === local.length && remote.every((row, i) => row === local[i])

console.log(`\n远端提交  : ${commit.sha}`)
console.log(`远端 tree : ${remoteTree.sha}`)
console.log(`远端文件  : ${remote.length}`)
console.log(same ? '✅ 远端 tree 与本地逐个文件、逐个 blob 摘要完全一致' : '❌ 远端 tree 与本地不一致')
if (!same) {
  const onlyLocal = local.filter((r) => !remote.includes(r))
  const onlyRemote = remote.filter((r) => !local.includes(r))
  console.log('  仅本地:', onlyLocal)
  console.log('  仅远端:', onlyRemote)
  process.exit(1)
}

// Keep the local repo's view coherent even though `git fetch` cannot reach
// github.com over this network.
try {
  execFileSync('git', ['-C', root, 'update-ref', 'refs/remotes/origin/main', commit.sha])
  execFileSync('git', ['-C', root, 'branch', '--set-upstream-to=origin/main', 'main'], { stdio: 'ignore' })
  console.log('已把本地 origin/main 指向该提交（无需 fetch）')
} catch (error) {
  console.log(`（未能更新本地跟踪引用：${error.message}）`)
}
