'use strict'

/**
 * dsh-github-sync-with-attachments — migration from the original plugin.
 *
 * Installing this fork creates a second settings namespace and a second state
 * directory, so without help the user would have to retype the repository URL
 * and the access token. Both are already on disk in the original plugin's two
 * storage layers:
 *
 *   `$DSH_HOME/settings.yaml` → the `dsh-github-sync:` block, written by the
 *                               harness settings service (the usual case);
 *   `$DSH_HOME/dsh-github-sync/config.json` → the plugin's own fallback store,
 *                               used when no settings service was available.
 *
 * This module reads both, once, at boot. It never writes: the fork's own
 * settings become authoritative the moment the user saves the settings page.
 *
 * Everything here is deliberately defensive. A malformed file, an unexpected
 * shape or a YAML feature outside the tiny subset below yields "no value" and
 * the user simply fills the field in by hand — the failure mode must never be a
 * wrong token silently in use, and the token is never logged.
 */

import fs from 'node:fs'
import { join } from 'node:path'

/** The original plugin's names. */
export const LEGACY_NAME = 'dsh-github-sync'

/**
 * Parse the flat scalar block of one top-level key out of a YAML document.
 *
 * Only what `settings.yaml` actually contains for this plugin is supported:
 * a `SECTION:` line at column 0 followed by two-space-indented `key: value`
 * scalar lines. Nested maps, lists, anchors, multi-line scalars and block
 * scalars are all reported as "not understood" by being skipped — a settings
 * file that uses them still parses for every other key.
 *
 * @param {string} text    the whole YAML document.
 * @param {string} section top-level key to extract.
 * @returns {Record<string, string|number|boolean>} scalar values by key.
 */
export function parseSimpleYamlSection(text, section) {
  const out = {}
  const lines = String(text).split(/\r?\n/)
  let inside = false
  for (const line of lines) {
    if (/^\S/.test(line)) {
      // A top-level key starts or ends the section; comments at column 0 too.
      if (!line.startsWith('#')) inside = line.trimEnd() === `${section}:`
      continue
    }
    if (!inside) continue
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const match = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(trimmed)
    if (!match) continue
    const [, key, rawValue] = match
    const value = parseScalar(rawValue)
    if (value !== undefined) out[key] = value
  }
  return out
}

/** Decode one YAML scalar, or `undefined` when it is not a plain scalar. */
function parseScalar(raw) {
  let value = String(raw).trim()
  // A trailing comment is only safe to strip when the value is not quoted.
  if (!/^['"]/.test(value)) {
    const hash = value.search(/\s#/)
    if (hash >= 0) value = value.slice(0, hash).trim()
  }
  if (value === '') return undefined
  // Block/flow collections are out of scope; skipping beats guessing.
  if (/^[[{|>&*!]/.test(value)) return undefined
  if (/^['"]/.test(value)) {
    const quote = value[0]
    if (value.length < 2 || !value.endsWith(quote)) return undefined
    const inner = value.slice(1, -1)
    return quote === "'" ? inner.replace(/''/g, "'") : inner.replace(/\\(["\\])/g, '$1')
  }
  if (value === 'true') return true
  if (value === 'false') return false
  if (/^-?\d+$/.test(value)) return Number.parseInt(value, 10)
  return value
}

/** Coerce a legacy value to the type the settings schema expects. */
function coerce(key, value, { booleans, numbers, strings }) {
  if (booleans.has(key)) {
    if (typeof value === 'boolean') return value
    if (value === 'true') return true
    if (value === 'false') return false
    return undefined
  }
  if (numbers.has(key)) {
    const n = typeof value === 'number' ? value : Number.parseInt(String(value), 10)
    return Number.isFinite(n) ? n : undefined
  }
  if (strings.has(key) || key === 'token') return typeof value === 'string' ? value : undefined
  return undefined
}

/**
 * Read the original plugin's settings from both of its storage layers.
 *
 * @param {object} options
 * @param {string} options.home     `$DSH_HOME`
 * @param {Set<string>} options.booleans keys with boolean semantics
 * @param {Set<string>} options.numbers  keys with numeric semantics
 * @param {Set<string>} options.strings  keys with string semantics
 * @returns {Record<string, string|number|boolean>} whatever could be recovered.
 */
export function readLegacySettings({ home, booleans = new Set(), numbers = new Set(), strings = new Set() } = {}) {
  const out = {}
  const yaml = readFile(join(home, 'settings.yaml'))
  if (yaml !== null) {
    const section = parseSimpleYamlSection(yaml, LEGACY_NAME)
    for (const [key, value] of Object.entries(section)) {
      const coerced = coerce(key, value, { booleans, numbers, strings })
      if (coerced !== undefined) out[key] = coerced
    }
  }
  // The plugin's own fallback file is more specific than the shared settings
  // document, so it wins where both define a key.
  const json = readFile(join(home, LEGACY_NAME, 'config.json'))
  if (json !== null) {
    try {
      const parsed = JSON.parse(json)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(parsed)) {
          const coerced = coerce(key, value, { booleans, numbers, strings })
          if (coerced !== undefined) out[key] = coerced
        }
      }
    } catch {
      /* an unreadable fallback file simply yields nothing */
    }
  }
  return out
}

function readFile(path) {
  try {
    return fs.readFileSync(path, 'utf8')
  } catch {
    return null
  }
}
