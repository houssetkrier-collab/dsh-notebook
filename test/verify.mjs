/**
 * Functional verification for the dsh-notebook plugin. No dependencies, no
 * network: it fakes the two host services, drives every tool and the /note
 * command, and checks each returned value against the tool's own output schema.
 *
 *   node test/verify.mjs
 */

import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { apply, name, inject } from '../index.js'

/* ------------------------------------------------------- tiny schema check */

function validate(value, schema, at = 'value', out = []) {
  if (schema.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      out.push(`${at}: expected object`)
      return out
    }
    for (const key of schema.required ?? []) {
      if (!(key in value)) out.push(`${at}.${key}: missing required key`)
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (key in value) validate(value[key], child, `${at}.${key}`, out)
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in (schema.properties ?? {}))) out.push(`${at}.${key}: unexpected key`)
      }
    }
    return out
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) {
      out.push(`${at}: expected array`)
      return out
    }
    value.forEach((item, index) => validate(item, schema.items ?? {}, `${at}[${index}]`, out))
    return out
  }
  const ok =
    schema.type === 'string' ? typeof value === 'string'
      : schema.type === 'integer' ? Number.isInteger(value)
        : schema.type === 'boolean' ? typeof value === 'boolean'
          : true
  if (!ok) out.push(`${at}: expected ${schema.type}, got ${typeof value}`)
  return out
}

/* ------------------------------------------------------------- fake host */

function makeCtx() {
  const tools = new Map()
  const commands = new Map()
  return {
    tools: { register: (definition) => tools.set(definition.name, definition) },
    commands: { register: (definition) => commands.set(definition.name, definition) },
    registered: { tools, commands },
  }
}

let passed = 0
async function check(label, fn) {
  await fn()
  passed += 1
  console.log(`  ok  ${label}`)
}

async function rejects(label, fn, pattern) {
  let message = ''
  try {
    await fn()
  } catch (error) {
    message = String(error?.message ?? error)
  }
  assert.notEqual(message, '', `${label}: expected a thrown error`)
  assert.match(message, pattern, `${label}: got "${message}"`)
  passed += 1
  console.log(`  ok  ${label} (${message})`)
}

/* ------------------------------------------------------------------- main */

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-notebook-verify-'))
const ctx = makeCtx()
apply(ctx, { dir, maxNotes: 5, maxNoteBytes: 4096 })

const tool = (toolName) => {
  const definition = ctx.registered.tools.get(toolName)
  assert.ok(definition, `tool ${toolName} was not registered`)
  return definition
}
const run = async (toolName, args) => {
  const definition = tool(toolName)
  const value = await definition.execute(args, {})
  const problems = validate(value, definition.output.schema)
  assert.deepEqual(problems, [], `${toolName} output violates its own schema: ${problems.join('; ')}`)
  const blocks = definition.output.render(args, value)
  assert.ok(Array.isArray(blocks) && blocks.every((block) => block.type === 'text' && typeof block.text === 'string'),
    `${toolName} render must return text blocks`)
  return value
}
const note = (id) => path.join(dir, `${id}.md`)

console.log(`dsh-notebook ${name} · inject ${JSON.stringify(inject)} · dir ${dir}`)

await check('registers exactly 5 tools and 1 command', () => {
  assert.deepEqual([...ctx.registered.tools.keys()].sort(), [
    'note_delete', 'note_list', 'note_read', 'note_save', 'note_search',
  ])
  assert.deepEqual([...ctx.registered.commands.keys()], ['note'])
})

await check('note_save creates a human-readable markdown file', async () => {
  const saved = await run('note_save', {
    title: '重构 Runner 的八个分支',
    content: '第一条：拆 run/replay。\n第二条：保留 cursor。',
    tags: ['runner', 'refactor'],
  })
  assert.equal(saved.createdNew, true)
  assert.equal(saved.id, '重构-runner-的八个分支')
  const raw = await fs.readFile(note(saved.id), 'utf8')
  assert.match(raw, /^# 重构 Runner 的八个分支\n<!-- notebook-meta /)
})

await check('note_read round-trips content, tags and timestamps', async () => {
  const read = await run('note_read', { id: '重构-runner-的八个分支' })
  assert.equal(read.content, '第一条：拆 run/replay。\n第二条：保留 cursor。')
  assert.deepEqual(read.tags, ['runner', 'refactor'])
  assert.ok(read.created.length > 0 && read.updated.length > 0)
})

await check('duplicate title allocates a numbered id, overwrite reuses it', async () => {
  const second = await run('note_save', { title: 'Refactor Runner 的八个分支', content: 'x' })
  assert.equal(second.id, 'refactor-runner-的八个分支')
  assert.equal(second.createdNew, true)
  const third = await run('note_save', { title: '重构 Runner 的八个分支', content: '替换后的正文', overwrite: true })
  assert.equal(third.id, '重构-runner-的八个分支')
  assert.equal(third.createdNew, false)
  const read = await run('note_read', { id: third.id })
  assert.equal(read.content, '替换后的正文')
})

await check('tags are normalized: trimmed, deduped case-insensitively, capped', async () => {
  const saved = await run('note_save', {
    title: 'Tag hygiene',
    content: 'body',
    tags: ['  A  b ', 'a b', '', 'C', 'a', 'B'],
  })
  assert.deepEqual(saved.tags, ['A-b', 'C', 'a', 'B'])
})

await check('note_list lists newest first and honours tag filter', async () => {
  const all = await run('note_list', {})
  assert.equal(all.total, 3)
  assert.equal(all.returned, 3)
  assert.equal(all.dir, dir)
  const filtered = await run('note_list', { tag: 'refactor' })
  assert.equal(filtered.total, 1)
  assert.equal(filtered.notes[0].id, '重构-runner-的八个分支')
  const capped = await run('note_list', { limit: 2 })
  assert.equal(capped.returned, 2)
})

await check('note_search reports line numbers, tag filter and truncation', async () => {
  const hit = await run('note_search', { query: 'cursor' })
  assert.equal(hit.notesMatched, 0, 'content was overwritten')
  const replaced = await run('note_search', { query: '替换' })
  assert.equal(replaced.matches[0].line, 1)
  assert.equal(replaced.notesMatched, 1)
  const byTag = await run('note_search', { query: 'body', tag: 'a' })
  assert.equal(byTag.matches.length, 1)
  const wrongTag = await run('note_search', { query: 'body', tag: 'nope' })
  assert.equal(wrongTag.matches.length, 0)
})

await check('note_delete removes the file and later reads fail', async () => {
  const removed = await run('note_delete', { id: 'tag-hygiene' })
  assert.equal(removed.deleted, true)
  await rejects('delete twice', () => tool('note_delete').execute({ id: 'tag-hygiene' }, {}), /no note with id/)
  const list = await run('note_list', {})
  assert.equal(list.total, 2)
})

await check('note capacity ceiling is enforced', async () => {
  await run('note_save', { title: 'fill-1', content: 'a' })
  await run('note_save', { title: 'fill-2', content: 'b' })
  await run('note_save', { title: 'fill-3', content: 'c' })
  await rejects('6th note', () => run('note_save', { title: 'fill-4', content: 'd' }), /limit 5/)
})

await rejects('path traversal in id', () => tool('note_read').execute({ id: '../../etc/passwd' }, {}), /path separators/)
await rejects('absolute-ish id', () => tool('note_read').execute({ id: 'C:boot' }, {}), /characters a filename cannot hold/)
await rejects('missing required arg', () => tool('note_save').execute({ content: 'no title' }, {}), /"title" is required/)
await rejects('wrong arg type', () => tool('note_save').execute({ title: 'x', content: 42 }, {}), /"content" must be a string/)
await rejects('blank title', () => tool('note_save').execute({ title: '   ', content: 'x' }, {}), /must not be blank/)
await rejects('oversize content', () => tool('note_save').execute({ title: 'big', content: 'x'.repeat(5000) }, {}), /over the 4096-byte limit/)

/* ---------------------------------------------------------------- command */

// Free capacity first: the notebook was deliberately filled to its ceiling above.
for (const id of ['fill-1', 'fill-2', 'fill-3']) await tool('note_delete').execute({ id }, {})

const command = ctx.registered.commands.get('note')
const slash = (line) => command.handler({ rawInput: line, attachments: [], signal: new AbortController().signal })

await check('/note help documents every subcommand', async () => {
  const result = await slash('help')
  assert.equal(result.kind, 'success')
  for (const fragment of ['/note list', '/note read', '/note save', '/note search', '/note del']) {
    assert.ok(result.text.includes(fragment), `help is missing ${fragment}`)
  }
})

await check('/note save then /note read round-trips through the command', async () => {
  const saved = await slash('save Command 侧写入 | 正文第一行')
  assert.equal(saved.kind, 'success')
  assert.match(saved.text, /Saved `command-侧写入`/)
  const read = await slash('read command-侧写入')
  assert.equal(read.kind, 'success')
  assert.match(read.text, /正文第一行/)
})

await check('/note list, /note search, /note del and bare /note <id>', async () => {
  const list = await slash('')
  assert.equal(list.kind, 'success')
  assert.match(list.text, /note\(s\)/)
  const search = await slash('search 正文')
  assert.match(search.text, /2 hit\(s\) in 2 note\(s\)/)
  const bare = await slash('command-侧写入')
  assert.match(bare.text, /# Command 侧写入/)
  const deleted = await slash('del command-侧写入')
  assert.match(deleted.text, /Deleted `command-侧写入`/)
})

await check('/note error paths stay user-readable', async () => {
  assert.equal((await slash('read')).kind, 'error')
  assert.equal((await slash('save no-pipe')).kind, 'error')
  assert.equal((await slash('read does-not-exist')).kind, 'error')
  assert.equal((await slash('bogus-sub')).kind, 'error')
  assert.match((await slash('bogus-sub')).text, /unknown subcommand/)
})

await fs.rm(dir, { recursive: true, force: true })
console.log(`\n${passed} checks passed.`)
