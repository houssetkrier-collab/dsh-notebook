#!/usr/bin/env node
/**
 * Install / uninstall dsh-notebook into one or more dsh profiles.
 *
 *   node scripts/install.mjs                      # desktop profile, defaults
 *   node scripts/install.mjs --profile desktop,web
 *   node scripts/install.mjs --dir D:\notes --max-notes 500
 *   node scripts/install.mjs --dry-run            # show what would change
 *   node scripts/install.mjs --uninstall
 *
 * What it touches, and nothing else:
 *   1. <profile>/node_modules/dsh-notebook  — a junction to this directory
 *   2. <profile>/cordis.patch.yml           — one `- insert:` entry (backed up first)
 *
 * It does not touch package.json, the lockfile, or anything under the app bundle,
 * so no `pnpm install` is required and a failed install rolls back by restoring
 * the .bak file and deleting the junction.
 */

import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN_ID = 'dsh-notebook'
const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DSH_HOME = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')

/* ---------------------------------------------------------------- arg parse */

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const value = (name, fallback = undefined) => {
  const at = argv.indexOf(`--${name}`)
  return at === -1 || at === argv.length - 1 ? fallback : argv[at + 1]
}

const uninstall = flag('uninstall')
const dryRun = flag('dry-run')
const profiles = String(value('profile', 'desktop'))
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean)

/* --------------------------------------------------------------------- yaml */

async function loadYaml(profileDir) {
  const candidates = [
    path.join(profileDir, 'node_modules', 'yaml', 'dist', 'index.js'),
    path.join(DSH_HOME, 'profiles', 'node_modules', 'yaml', 'dist', 'index.js'),
  ]
  for (const candidate of candidates) {
    try {
      return await import(pathToFileURL(candidate).href)
    } catch {
      continue
    }
  }
  throw new Error(`cannot find the yaml package (looked in ${candidates.join(', ')})`)
}

/* ------------------------------------------------------------------- patch */

const holdsOurs = (entry) =>
  entry && typeof entry === 'object' && Array.isArray(entry.insert) &&
  entry.insert.some((item) => item && item.id === PLUGIN_ID)

/** YAML text for the one array item this plugin owns. */
function insertBlock(config) {
  const lines = ['- insert:', `    - id: ${PLUGIN_ID}`, `      name: ${PLUGIN_ID}`]
  if (config) {
    lines.push('      config:')
    for (const [key, value] of Object.entries(config)) {
      lines.push(`        ${key}: ${typeof value === 'string' ? JSON.stringify(value) : value}`)
    }
  }
  return `${lines.join('\n')}\n`
}

function pluginConfig() {
  const config = {}
  const dir = value('dir')
  const maxNotes = value('max-notes')
  const maxNoteBytes = value('max-note-bytes')
  if (dir) config.dir = path.resolve(dir)
  if (maxNotes) config.maxNotes = Number(maxNotes)
  if (maxNoteBytes) config.maxNoteBytes = Number(maxNoteBytes)
  return Object.keys(config).length > 0 ? config : undefined
}

async function editPatch(profileDir) {
  const file = path.join(profileDir, 'cordis.patch.yml')
  const yaml = await loadYaml(profileDir)
  const original = await fs.readFile(file, 'utf8')
  const doc = yaml.parseDocument(original)
  if (doc.errors.length > 0) throw new Error(`patch layer does not parse: ${doc.errors[0].message}`)

  const plain = doc.toJS()
  if (plain !== null && !Array.isArray(plain)) throw new Error('patch layer is not a top-level array')
  const entries = Array.isArray(plain) ? plain : []
  const items = doc.contents?.items ?? []

  // Splice out our own entries by source range so every comment and every other
  // entry keeps its exact original text.
  const ours = []
  entries.forEach((entry, index) => {
    if (holdsOurs(entry)) ours.push(index)
  })

  let text = original
  for (const index of [...ours].reverse()) {
    const start = items[index]?.range?.[0]
    if (typeof start !== 'number') throw new Error('cannot locate the existing insert entry in the patch text')
    const end = index + 1 < items.length && typeof items[index + 1]?.range?.[0] === 'number'
      ? items[index + 1].range[0]
      : text.length
    text = text.slice(0, start) + text.slice(end)
  }
  text = `${text.replace(/\s+$/u, '')}\n`

  let action
  if (uninstall) {
    action = ours.length > 0 ? `removed ${ours.length} insert entr${ours.length === 1 ? 'y' : 'ies'}` : 'nothing to remove'
  } else {
    text = `${text}${insertBlock(pluginConfig())}`
    action = `${ours.length > 0 ? 'replaced' : 'added'} the insert entry`
  }

  // Fail closed: never write a patch layer this profile could not parse back.
  const verifyDoc = yaml.parseDocument(text)
  if (verifyDoc.errors.length > 0) {
    throw new Error(`refusing to write: patch layer would not parse (${verifyDoc.errors[0].message})`)
  }
  const verify = verifyDoc.toJS()
  if (!Array.isArray(verify)) throw new Error('refusing to write: patch layer no longer parses as an array')
  const presentNow = verify.filter(holdsOurs).length
  if (!uninstall && presentNow !== 1) throw new Error('refusing to write: insert entry is missing')
  if (uninstall && presentNow !== 0) throw new Error('refusing to write: insert entry survived removal')

  if (text === original) return { file, action: 'already up to date', changed: false }
  if (!dryRun) {
    const backup = `${file}.bak-notebook-${new Date().toISOString().replace(/[:.]/gu, '-')}`
    await fs.copyFile(file, backup)
    await fs.writeFile(file, text, 'utf8')
    return { file, action, changed: true, backup }
  }
  return { file, action: `${action} (dry run, not written)`, changed: true }
}

/* ---------------------------------------------------------------- junction */

async function linkState(profileDir) {
  const link = path.join(profileDir, 'node_modules', PLUGIN_ID)
  try {
    const stat = await fs.lstat(link)
    if (!stat.isSymbolicLink()) return { link, state: 'real-directory' }
    const target = await fs.realpath(link)
    const want = await fs.realpath(PLUGIN_DIR)
    return { link, state: target === want ? 'linked' : 'points-elsewhere', target }
  } catch (error) {
    if (error?.code === 'ENOENT') return { link, state: 'missing' }
    throw error
  }
}

function makeJunction(link) {
  if (process.platform === 'win32') {
    execFileSync('cmd', ['/c', 'mklink', '/J', link, PLUGIN_DIR], { stdio: 'pipe' })
    return
  }
  execFileSync('ln', ['-sfn', PLUGIN_DIR, link], { stdio: 'pipe' })
}

function removeJunction(link) {
  if (process.platform === 'win32') {
    // rmdir detaches a junction without ever walking into the target.
    execFileSync('cmd', ['/c', 'rmdir', link], { stdio: 'pipe' })
    return
  }
  execFileSync('rm', ['-f', link], { stdio: 'pipe' })
}

async function editLink(profileDir) {
  const before = await linkState(profileDir)
  if (uninstall) {
    if (before.state === 'missing') return { link: before.link, action: 'no junction' }
    if (before.state === 'real-directory') return { link: before.link, action: 'left a real directory alone' }
    if (!dryRun) removeJunction(before.link)
    return { link: before.link, action: 'removed the junction' }
  }

  if (before.state === 'linked') return { link: before.link, action: 'junction already present' }
  if (before.state === 'points-elsewhere') {
    if (!dryRun) {
      removeJunction(before.link)
      makeJunction(before.link)
    }
    return { link: before.link, action: `repointed from ${before.target}` }
  }
  if (before.state === 'real-directory') {
    return { link: before.link, action: 'a real directory already sits there — left alone, remove it yourself' }
  }
  if (!dryRun) {
    await fs.mkdir(path.dirname(before.link), { recursive: true })
    makeJunction(before.link)
  }
  return { link: before.link, action: 'created the junction' }
}

/* -------------------------------------------------------------------- main */

console.log(`${uninstall ? 'Uninstalling' : 'Installing'} ${PLUGIN_ID} from ${PLUGIN_DIR}`)
console.log(`profiles: ${profiles.join(', ')}${dryRun ? ' (dry run)' : ''}\n`)

for (const profileName of profiles) {
  const profileDir = path.join(DSH_HOME, 'profiles', profileName)
  const exists = await fs
    .stat(path.join(profileDir, 'cordis.patch.yml'))
    .then(() => true)
    .catch(() => false)
  if (!exists) {
    console.log(`  ${profileName}: no cordis.patch.yml — skipped`)
    continue
  }
  const patch = await editPatch(profileDir)
  const link = await editLink(profileDir)
  console.log(`  ${profileName}: patch ${patch.action} → ${patch.file}`)
  console.log(`  ${profileName}: ${link.action} → ${link.link}`)
}

if (!uninstall) {
  console.log(
    [
      '',
      'The plugin is on disk. A running DSH process loads profile plugins at boot,',
      'so restart the app (or its profile) to get note_save / note_list / note_read /',
      'note_search / note_delete and the /note command.',
    ].join('\n'),
  )
}
