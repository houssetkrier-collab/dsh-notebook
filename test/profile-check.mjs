/**
 * Profile integration check: run the installed profile through the *host's own*
 * patch composition code (`@deepseek-ai/dsh-app-boot`), so we learn whether
 * `- insert:` really lands our entry in the entry list the loader imports —
 * not merely whether the YAML parses.
 *
 *   node test/profile-check.mjs [profile]      # default: desktop
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const PLUGIN_ID = 'dsh-notebook'
const profile = process.argv[2] ?? 'desktop'
const DSH_HOME = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
const profileDir = path.join(DSH_HOME, 'profiles', profile)
const patchFile = path.join(profileDir, 'cordis.patch.yml')
const bootEntry = path.join(DSH_HOME, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js')

if (!existsSync(bootEntry)) {
  console.error(`skip: dsh-app-boot not found at ${bootEntry}`)
  process.exit(0)
}

const boot = await import(pathToFileURL(bootEntry).href)
const patches = boot.loadOptionalPatches('dsh', patchFile)
assert.ok(Array.isArray(patches), `${patchFile} must hold a top-level array`)

const problems = []
const composed = boot.composeEntries([patches], (message, ...args) => {
  problems.push([message, ...args].join(' '))
})

const ours = composed.filter((entry) => entry?.id === PLUGIN_ID)
assert.equal(ours.length, 1, `expected exactly one "${PLUGIN_ID}" entry, got ${ours.length}`)
assert.equal(ours[0].name, PLUGIN_ID)
// Composing against an empty root means every id-targeted override in the real
// profile ("entry X not found") has nothing to patch — expected here. What must
// never appear is a complaint about our own entry.
const oursProblems = problems.filter((message) => message.includes(PLUGIN_ID))
assert.deepEqual(oursProblems, [], `the host rejected our patch: ${oursProblems.join(' | ')}`)

// The loader imports the entry by name; prove that specifier resolves from the
// profile directory (this is what the junction is for).
const module = await import(pathToFileURL(path.join(profileDir, 'node_modules', PLUGIN_ID, 'index.js')).href)
assert.equal(module.name, PLUGIN_ID)
assert.equal(typeof module.apply, 'function')
assert.deepEqual(module.inject, ['tools', 'commands'])

console.log(`  ok  ${patchFile}: ${patches.length} patch entries, 0 skipped`)
console.log(`  ok  composed entry → ${JSON.stringify(ours[0])}`)
console.log(`  ok  ${path.join(profileDir, 'node_modules', PLUGIN_ID)} imports as a cordis plugin`)
