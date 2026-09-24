#!/usr/bin/env node
'use strict'

/**
 * Build `client/bundle.js` from `client/index.js`.
 *
 * The client-modules loader in the dsh web shell does not resolve bare
 * specifiers or read a second file: a plugin client ships as one script that
 * calls `window.__ModuleLoader__.load({ id, factory })`. `client/index.js` is
 * written to be valid inside that factory already — it uses
 * `React.createElement`, pulls the shared primitives through `require`, and
 * ends with `module.exports = plugin` — so the build is a wrapper, not a
 * transpile: the factory body is the source file, indented by one level, with
 * `react` bound at the top.
 *
 * The original package shipped this script only in its repository, not in the
 * published tarball, so this file is a reimplementation of the same envelope
 * (verified line-for-line against the 0.4.3 release bundle).
 */

import fs from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const sourcePath = join(root, 'client', 'index.js')
const targetPath = join(root, 'client', 'bundle.js')

const pkg = JSON.parse(fs.readFileSync(join(root, 'package.json'), 'utf8'))
const source = fs.readFileSync(sourcePath, 'utf8')

/** Indent every non-empty line by one level; blank lines stay truly blank. */
const indent = (text) => text.split('\n').map((line) => (line === '' ? line : `    ${line}`)).join('\n')

const bundle = [
  '/* Generated from client/index.js by scripts/build-client.mjs — do not edit by hand.',
  ' * Regenerate with: npm run build:client',
  ' */',
  'window.__ModuleLoader__.load({',
  `  id: ${JSON.stringify(pkg.name)},`,
  '  factory: (require) => {',
  '    var module = { exports: {} }',
  '    var exports = module.exports',
  '    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" })',
  '    var React = require("react")',
  indent(source),
  '    return module.exports',
  '  }',
  '})',
  '',
].join('\n')

fs.writeFileSync(targetPath, bundle)
console.log(`wrote ${targetPath} (${bundle.length} bytes) from ${sourcePath}`)
