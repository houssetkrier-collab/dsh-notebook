/**
 * SDK conformance check: feed the plugin's hand-written schemas through the
 * *real* `@deepseek-ai/dsh-tools` validators that the host runs at registration
 * time, so a schema the host would reject fails here instead of at boot.
 *
 * The SDK is imported by absolute path (the plugin itself is dependency-free and
 * resolves nothing but node: builtins); override with DSH_TOOLS_ENTRY if the
 * profile lives elsewhere.
 *
 *   node test/sdk-check.mjs
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { apply } from '../index.js'

const entry = process.env.DSH_TOOLS_ENTRY
  ?? path.join(os.homedir(), '.dsh', 'profiles', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js')

if (!existsSync(entry)) {
  console.error(`skip: dsh-tools not found at ${entry} (set DSH_TOOLS_ENTRY)`)
  process.exit(0)
}

const sdk = await import(pathToFileURL(entry).href)
for (const fn of ['assertSupportedJsonSchema', 'assertObjectJsonSchema']) {
  assert.equal(typeof sdk[fn], 'function', `SDK is missing ${fn}`)
}

const tools = new Map()
const commands = new Map()
apply({ tools: { register: (d) => tools.set(d.name, d) }, commands: { register: (d) => commands.set(d.name, d) } }, {})

let checked = 0
for (const definition of tools.values()) {
  assert.equal(typeof definition.execute, 'function', `${definition.name}: execute must be a function`)
  assert.equal(typeof definition.output?.render, 'function', `${definition.name}: output.render must be a function`)
  assert.notEqual(definition.name, sdk.RUN_CODE_NAME, `${definition.name}: name is reserved`)

  // Argument declaration: an object-rooted schema in the supported subset.
  sdk.assertObjectJsonSchema(definition.parameters)
  // Output schema: exactly what the registry asserts on register().
  sdk.assertSupportedJsonSchema(definition.output.schema)
  // The host renders the declaration for the model; it must not throw.
  const ts = sdk.jsonSchemaToTs(definition.parameters, 1)
  assert.equal(typeof ts, 'string', `${definition.name}: jsonSchemaToTs must produce a string`)
  checked += 1
  console.log(`  ok  ${definition.name} — parameters + output schema accepted by dsh-tools`)
}

assert.deepEqual([...commands.keys()], ['note'])
assert.ok(checked === tools.size && checked > 0)
console.log(`\n${checked} tool schemas validated against ${entry}`)
