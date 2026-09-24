/**
 * dsh-github-sync — filesystem layout of a dsh installation.
 *
 * Everything this plugin mirrors lives under `$DSH_HOME` (default `~/.dsh`):
 *
 *   sessions/<workspaceKey>/<sessionId>/session[.vN].jsonl.zstd
 *   profiles/<profile>/{package.json,cordis.patch.yml,pnpm-lock.yaml,pnpm-workspace.yaml}
 *   settings.yaml
 *   dsh-github-sync/{state.json,config.json,snapshots/}   ← this plugin
 *
 * The module is dependency-free on purpose: pure path arithmetic plus a little
 * `fs` reading, so the whole sync engine stays testable outside a harness.
 *
 * Two facts drive the shape of this file, both verified against the harness
 * sources (`dsh-session-persistence-jsonl`):
 *   - a project directory name is `projectKey(cwd)`, a *lossy* encoding;
 *   - a session directory may hold several generations of the log at once
 *     (`session.jsonl.zstd` plus a newer `session.vN.jsonl.zstd`), so a backup
 *     must copy the whole directory, never "the newest file".
 */

import fs from 'node:fs'
import fsP from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'

/** Plugin state directory name under `$DSH_HOME`. */
export const STATE_DIR_NAME = 'dsh-github-sync'

/** `$DSH_HOME`, honouring the env override the harness itself uses. */
export function dshHome(env = process.env) {
  return env.DSH_HOME ? resolve(env.DSH_HOME) : join(homedir(), '.dsh')
}

/** `~`-abbreviated form for display in the UI (never used for IO). */
export function displayPath(p) {
  const home = homedir()
  if (p === home) return '~'
  if (p.startsWith(home + sep)) return '~' + p.slice(home.length)
  if (p.startsWith(home + '/')) return '~' + p.slice(home.length)
  return p
}

// ── Workspace directory keys ─────────────────────────────────────────────
//
// A workspace directory becomes exactly one `sessions/<key>/` folder. Observed:
//
//   C:\Users\me\.dsh                     → --C-Users-me-.dsh--
//   D:\Program Files\JetBrains\dsh-plugin → --D-Program~0020Files-JetBrains-dsh-plugin--
//
// i.e. `[A-Za-z0-9._-]` pass through, `~` and every other unsafe code unit
// become `~XXXX` (uppercase hex), runs of `/ \ :` collapse into one `-`,
// leading dashes are dropped, the segment is capped at 251 chars, and the
// whole thing is wrapped in `--…--`.

const WORKSPACE_SAFE = /^[A-Za-z0-9._-]$/

/**
 * Mirror of the harness's `projectKey()` — keep the two in step, because a
 * mismatch would write a restored session into a folder the harness never
 * looks at.
 */
export function encodeWorkspaceKey(dir) {
  const raw = String(dir)
  let out = ''
  let separatorRun = false
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) out += '-'
      separatorRun = true
    } else if (ch !== '~' && WORKSPACE_SAFE.test(ch)) {
      out += ch
      separatorRun = false
    } else {
      out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  return `--${(out.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/**
 * Best-effort inverse of {@link encodeWorkspaceKey}, for display only.
 * The harness encoding is intentionally lossy (`:`, `\` and `/` all become
 * `-`), so a decoded key is a hint and never a path to write to.
 */
export function decodeWorkspaceKey(key) {
  let s = String(key)
  if (s.startsWith('--') && s.endsWith('--')) s = s.slice(2, -2)
  s = s.replace(/~([0-9A-Fa-f]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
  s = s.replace(/-/g, '\\')
  if (/^[A-Za-z]\\/.test(s)) s = s[0] + ':' + s.slice(1)
  return s
}

/** Absolute paths of every workspace session folder that exists locally. */
export async function listWorkspaceDirs(home = dshHome()) {
  const root = join(home, 'sessions')
  let entries
  try {
    entries = await fsP.readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((e) => e.isDirectory() && e.name.startsWith('--'))
    .map((e) => ({ key: e.name, dir: join(root, e.name) }))
}

/**
 * Profile names (`web`, `dsh-tui`, …) that are initialised under `profiles/`.
 * There is no enumeration API in the harness, so this walks the directory and
 * treats "has a package.json" as the test.
 */
export async function listProfiles(home = dshHome()) {
  const root = join(home, 'profiles')
  let entries
  try {
    entries = await fsP.readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const e of entries) {
    if (!e.isDirectory() || e.name === 'node_modules') continue
    try {
      await fsP.access(join(root, e.name, 'package.json'))
      out.push(e.name)
    } catch {
      /* not an initialised profile */
    }
  }
  return out.sort()
}

/** Synchronous profile probe, used where the caller cannot await. */
export function profileExists(profile, home = dshHome()) {
  try {
    return fs.existsSync(join(home, 'profiles', profile, 'package.json'))
  } catch {
    return false
  }
}

/**
 * Real project paths, keyed by the session folder name.
 *
 * `projectKey()` is lossy — `-`, `\` and `:` all encode to `-` — so a folder
 * name cannot be decoded back into a path (`git-workspace\data-push` would
 * come back as `git\workspace\data\push`). The harness's own workspace
 * registry (`storages/workspace.json`) does carry the real paths, so that is
 * the authoritative source; {@link decodeWorkspaceKey} stays only as the
 * fallback for a machine whose registry we cannot read (a remote backup, for
 * instance, which carries just a folder name).
 *
 * @returns a map from encoded folder name to `{ path, title }`.
 */
export async function workspacePathMap(home = dshHome()) {
  const raw = await fsP.readFile(join(home, 'storages', 'workspace.json'), 'utf8').catch(() => null)
  if (!raw) return new Map()
  let doc
  try {
    doc = JSON.parse(raw)
  } catch {
    return new Map()
  }
  const table = doc && doc.tables && doc.tables.workspaces
  if (!table || typeof table !== 'object') return new Map()
  const map = new Map()
  for (const entry of Object.values(table)) {
    if (!entry || typeof entry.path !== 'string' || entry.path === '') continue
    map.set(encodeWorkspaceKey(entry.path), {
      path: entry.path,
      title: typeof entry.title === 'string' && entry.title !== '' ? entry.title : undefined,
    })
  }
  return map
}

/**
 * Files inside a session directory that are not part of the session: local
 * caches, locks and half-written temporaries. Everything else is copied
 * byte-for-byte, including older log generations.
 */
const SESSION_EXCLUDE_NAMES = new Set(['session.lock', 'session_projcache.json'])

export function isExcludedSessionFile(name) {
  if (SESSION_EXCLUDE_NAMES.has(name)) return true
  if (name.endsWith('.tmp')) return true
  if (name.startsWith('.dsh-mkdir')) return true
  return false
}

// ── Attachments ──────────────────────────────────────────────────────────
//
// `$DSH_HOME/attachments/v1/` is the harness's durable attachment store
// (`@deepseek-ai/dsh-attachment-local`). Image bytes are content-addressed
// objects at `objects/<xx>/<sha256>`; non-image files are objects at
// `file-objects/<xx>/<sha256>` with a hard-linked human-readable alias at
// `files/<xx>/<sha256>/<original name>`. Git stores identical blobs only once,
// so mirroring the alias tree costs no repository space.
//
// The whole `attachments/` tree is mirrored, not just the current `v1`, so a
// future store version cannot be silently skipped. Session logs reference these
// objects by `sha256:<hex>`, and the harness refuses a missing or
// digest-mismatched one — which is exactly why a session restored without its
// attachments cannot send a single request.

/**
 * Directory names inside the attachment store that are never backed up.
 *
 *   `tmp/`             the staging file of an in-flight publish — the object it
 *                      becomes does not exist until that file is hard-linked
 *                      into place, so uploading one could only capture a
 *                      half-written object.
 *   `request-images/`  the request-time normalization cache. An entry is named
 *                      after the digest of a variant *identity* (source ref +
 *                      provider image policy), not of its bytes, and a missing
 *                      entry is not a failure: `readImageRequest()` →
 *                      `readCached()` returns undefined on ENOENT and
 *                      `createRequestImage()` rebuilds the variant from the
 *                      durable object on the next request. Mirroring it would
 *                      put derived, policy-dependent data into git history
 *                      forever for no benefit.
 */
const ATTACHMENT_EXCLUDE_SEGMENTS = new Set(['tmp', 'request-images'])

/**
 * Is this attachment-store path local scratch or regenerable cache rather than
 * durable state? See {@link ATTACHMENT_EXCLUDE_SEGMENTS}.
 *
 * @param {string} relPath store-relative POSIX path (`v1/objects/ab/abcd…`).
 */
export function isExcludedAttachmentPath(relPath) {
  const parts = String(relPath).split('/')
  // Only the *bucket* slot directly under the version directory picks an
  // excluded tree. Matching the name anywhere would also drop a legitimate
  // attachment a user happened to name `tmp` (stored as
  // `v1/files/<xx>/<digest>/tmp`), which is exactly the kind of silent loss
  // this group exists to prevent.
  if (parts.length >= 2 && ATTACHMENT_EXCLUDE_SEGMENTS.has(parts[1])) return true
  const name = parts[parts.length - 1] || ''
  if (name.endsWith('.tmp')) return true
  if (name.startsWith('.dsh-')) return true
  return false
}

/**
 * The content digest an attachment-store path promises, or `undefined` when the
 * path is not content-addressed (so nothing can be verified against it).
 *
 * Recognized shapes, with `<digest>` the 64-hex sha256:
 *   `<version>/objects/<xx>/<digest>`
 *   `<version>/file-objects/<xx>/<digest>`
 *   `<version>/files/<xx>/<digest>/<name>`
 *
 * @param {string} relPath store-relative POSIX path.
 */
export function attachmentDigestOf(relPath) {
  const parts = String(relPath).split('/')
  const bucket = parts.findIndex((part) => part === 'objects' || part === 'file-objects' || part === 'files')
  if (bucket < 0) return undefined
  const digest = parts[bucket + 2]
  if (!/^[0-9a-f]{64}$/.test(String(digest))) return undefined
  if (parts[bucket] === 'files' && parts.length < bucket + 4) return undefined
  return digest
}

/**
 * Files that describe a profile's plugin set. `cordis.yml` is deliberately
 * absent: the launcher rewrites it on every boot. `node_modules/` is never
 * walked at all.
 */
export const PLUGIN_MANIFEST_FILES = ['package.json', 'cordis.patch.yml', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']
