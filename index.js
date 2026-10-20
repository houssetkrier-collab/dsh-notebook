/**
 * dsh-notebook — a self-contained DSH host plugin.
 *
 * Registers five model-facing tools plus one slash command on top of a plain
 * markdown directory, so notes survive across sessions without any database,
 * network call or third-party dependency.
 *
 * Design notes (why it looks like this):
 *  - Zero bare imports. A DSH plugin loaded through a profile junction resolves
 *    bare specifiers against its *realpath*, which is outside the profile's
 *    node_modules; only `node:` builtins are guaranteed. Tool definitions are
 *    therefore hand-built and arguments are validated here, not by `defineTool`.
 *  - Files are human-readable: `# title`, one meta comment line, then the body.
 *    A user can open the directory in any editor and nothing breaks.
 *  - Every write is atomic (tmp file + rename) so a crashed save never leaves a
 *    truncated note behind.
 *
 * @module dsh-notebook
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'dsh-notebook'
export const inject = ['tools', 'commands']

const META_PREFIX = '<!-- notebook-meta '
const META_SUFFIX = ' -->'
const ID_MAX = 60
const TAG_MAX = 12
const TAG_LEN_MAX = 40

/** Fallback used when the config layer is absent or partial. */
const DEFAULTS = {
  dir: path.join(os.homedir(), '.dsh', 'notebook'),
  maxNotes: 200,
  maxNoteBytes: 262144,
}

/* ------------------------------------------------------------------ config */

function resolveConfig(config) {
  const raw = config && typeof config === 'object' ? config : {}
  const dir =
    typeof raw.dir === 'string' && raw.dir.trim().length > 0
      ? path.resolve(raw.dir.trim())
      : DEFAULTS.dir
  const maxNotes =
    Number.isInteger(raw.maxNotes) && raw.maxNotes > 0 ? raw.maxNotes : DEFAULTS.maxNotes
  const maxNoteBytes =
    Number.isInteger(raw.maxNoteBytes) && raw.maxNoteBytes >= 4096
      ? raw.maxNoteBytes
      : DEFAULTS.maxNoteBytes
  return { dir, maxNotes, maxNoteBytes }
}

/* -------------------------------------------------------------- validation */

/**
 * Minimal argument checker. The registry enforces the *output* schema, but a
 * hand-built definition does not get `defineTool`'s argument gate, so each tool
 * validates its own input and fails with a message a model can act on.
 */
function expectArgs(args, spec) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('arguments must be an object')
  }
  const problems = []
  for (const [key, rule] of Object.entries(spec)) {
    const value = args[key]
    if (value === undefined || value === null) {
      if (rule.required) problems.push(`"${key}" is required`)
      continue
    }
    if (rule.type === 'string' && typeof value !== 'string') {
      problems.push(`"${key}" must be a string`)
      continue
    }
    if (rule.type === 'boolean' && typeof value !== 'boolean') {
      problems.push(`"${key}" must be a boolean`)
      continue
    }
    if (rule.type === 'integer' && !Number.isInteger(value)) {
      problems.push(`"${key}" must be an integer`)
      continue
    }
    if (rule.type === 'string[]') {
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
        problems.push(`"${key}" must be an array of strings`)
        continue
      }
    }
    if (rule.min !== undefined && typeof value === 'string' && value.length < rule.min) {
      problems.push(`"${key}" must be at least ${rule.min} characters`)
    }
  }
  if (problems.length > 0) throw new Error(`invalid arguments: ${problems.join('; ')}`)
}

/* -------------------------------------------------------------------- store */

function slugify(title) {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, ID_MAX)
    .replace(/-+$/u, '')
  return slug.length > 0 ? slug : 'note'
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return []
  const seen = new Set()
  const out = []
  for (const raw of tags) {
    if (typeof raw !== 'string') continue
    const tag = raw.trim().replace(/\s+/g, '-').slice(0, TAG_LEN_MAX)
    if (tag.length === 0) continue
    const key = tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(tag)
    if (out.length >= TAG_MAX) break
  }
  return out
}

/** Reject anything that could escape the notebook directory. */
function assertSafeId(id) {
  if (typeof id !== 'string' || id.length === 0) throw new Error('"id" must be a non-empty string')
  if (id.length > ID_MAX + 8) throw new Error(`"id" is longer than ${ID_MAX + 8} characters`)
  if (id.includes('/') || id.includes('\\') || id.includes('..')) {
    throw new Error('"id" may not contain path separators or ".."')
  }
  if (id.startsWith('.')) throw new Error('"id" may not start with "."')
  if (/[<>:"|?*\u0000-\u001f]/u.test(id)) throw new Error('"id" contains characters a filename cannot hold')
  return id
}

function serializeNote({ title, tags, created, updated, content }) {
  const meta = JSON.stringify({ tags, created, updated })
  return `# ${title}\n${META_PREFIX}${meta}${META_SUFFIX}\n${content}`
}

function parseNote(id, raw) {
  const newlineAt = raw.indexOf('\n')
  const first = newlineAt === -1 ? raw : raw.slice(0, newlineAt)
  let rest = newlineAt === -1 ? '' : raw.slice(newlineAt + 1)
  let title = first.startsWith('# ') ? first.slice(2).trim() : ''
  let meta = {}
  if (rest.startsWith(META_PREFIX)) {
    const end = rest.indexOf(META_SUFFIX)
    if (end !== -1) {
      const json = rest.slice(META_PREFIX.length, end)
      try {
        const parsed = JSON.parse(json)
        if (parsed && typeof parsed === 'object') meta = parsed
      } catch {
        meta = {}
      }
      rest = rest.slice(end + META_SUFFIX.length)
      if (rest.startsWith('\n')) rest = rest.slice(1)
    }
  }
  return {
    id,
    title: title.length > 0 ? title : id,
    tags: normalizeTags(meta.tags),
    created: typeof meta.created === 'string' ? meta.created : '',
    updated: typeof meta.updated === 'string' ? meta.updated : '',
    content: rest.replace(/\n$/u, ''),
  }
}

function createStore(config) {
  const { dir, maxNotes, maxNoteBytes } = config

  const fileOf = (id) => path.join(dir, `${assertSafeId(id)}.md`)

  async function ensureDir() {
    await fs.mkdir(dir, { recursive: true })
  }

  async function readNote(id) {
    const file = fileOf(id)
    let raw
    try {
      raw = await fs.readFile(file, 'utf8')
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        throw new Error(`no note with id "${id}" in ${dir}`)
      }
      throw error
    }
    return parseNote(id, raw)
  }

  async function listNotes() {
    await ensureDir()
    let names
    try {
      names = await fs.readdir(dir)
    } catch (error) {
      if (error && error.code === 'ENOENT') return []
      throw error
    }
    const notes = []
    for (const entry of names) {
      if (!entry.endsWith('.md') || entry.startsWith('.')) continue
      try {
        const note = await readNote(entry.slice(0, -3))
        notes.push(note)
      } catch {
        continue
      }
    }
    notes.sort((a, b) => {
      const delta = (b.updated || '').localeCompare(a.updated || '')
      return delta !== 0 ? delta : a.title.localeCompare(b.title)
    })
    return notes
  }

  async function freeId(base) {
    for (let n = 1; n <= 999; n += 1) {
      const candidate = n === 1 ? base : `${base}-${n}`
      try {
        await fs.access(fileOf(candidate))
      } catch {
        return candidate
      }
    }
    throw new Error(`too many notes titled "${base}"`)
  }

  async function saveNote({ title, content, tags, overwrite }) {
    const cleanTitle = title.trim().replace(/\s+/gu, ' ')
    if (cleanTitle.length === 0) throw new Error('"title" must not be blank')
    const body = typeof content === 'string' ? content : ''
    const bodyBytes = Buffer.byteLength(body, 'utf8')
    if (bodyBytes > maxNoteBytes) {
      throw new Error(
        `content is ${bodyBytes} bytes, over the ${maxNoteBytes}-byte limit for a single note`,
      )
    }

    await ensureDir()
    const base = slugify(cleanTitle)
    const existing = await listNotes()
    if (existing.length >= maxNotes && !(overwrite && existing.some((note) => note.id.startsWith(base)))) {
      throw new Error(
        `notebook already holds ${existing.length} notes (limit ${maxNotes}); delete some or raise config.maxNotes`,
      )
    }

    let id
    let created
    let replaced = false
    let inheritedTags = []
    if (overwrite) {
      const match = existing.find((note) => note.id === base || note.id.startsWith(`${base}-`))
      if (match) {
        id = match.id
        created = match.created || new Date().toISOString()
        inheritedTags = match.tags
        replaced = true
      }
    }
    if (!id) id = await freeId(base)

    // An overwrite that omits `tags` keeps the tags the note already carried,
    // so updating a body never silently drops its labels.
    const tagList = Array.isArray(tags) ? normalizeTags(tags) : inheritedTags
    const updated = new Date().toISOString()
    const payload = serializeNote({
      title: cleanTitle,
      tags: tagList,
      created: created || updated,
      updated,
      content: body,
    })
    const file = fileOf(id)
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
    await fs.writeFile(tmp, payload, 'utf8')
    await fs.rename(tmp, file)
    return {
      id,
      title: cleanTitle,
      tags: tagList,
      created: created || updated,
      updated,
      bytes: Buffer.byteLength(payload, 'utf8'),
      createdNew: !replaced,
      path: file,
    }
  }

  async function deleteNote(id) {
    const note = await readNote(id)
    await fs.rm(fileOf(id), { force: true })
    return { id, title: note.title }
  }

  async function searchNotes({ query, tag, limit }) {
    const needle = query.toLowerCase()
    const wantedTag = typeof tag === 'string' && tag.trim().length > 0 ? tag.trim().toLowerCase() : null
    const matches = []
    let notesMatched = 0
    for (const note of await listNotes()) {
      if (wantedTag && !note.tags.some((item) => item.toLowerCase() === wantedTag)) continue
      const lines = note.content.split('\n')
      const hits = []
      for (let index = 0; index < lines.length; index += 1) {
        if (lines[index].toLowerCase().includes(needle)) {
          hits.push({ line: index + 1, text: lines[index].slice(0, 400) })
        }
      }
      const titleHit = note.title.toLowerCase().includes(needle)
      if (hits.length === 0 && !titleHit) continue
      notesMatched += 1
      for (const hit of hits) {
        if (matches.length >= limit) continue
        matches.push({ id: note.id, title: note.title, line: hit.line, text: hit.text })
      }
    }
    return { matches, notesMatched, truncated: matches.length >= limit }
  }

  return { dir, readNote, listNotes, saveNote, deleteNote, searchNotes }
}

/* -------------------------------------------------------------------- tools */

function text(value) {
  return [{ type: 'text', text: value }]
}

function makeTools(store, config) {
  return [
    {
      name: 'note_save',
      description:
        'Save or update a markdown note in the local notebook. Use it to keep durable facts, decisions, ' +
        'findings and to-do context that must survive the end of a session. Re-saving with the same title ' +
        'overwrites the existing note only when overwrite=true; otherwise a numbered variant id is allocated.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Human title; also derives the note id.' },
          content: { type: 'string', description: 'Markdown body of the note.' },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional labels for later filtering (max 12).',
          },
          overwrite: {
            type: 'boolean',
            description: 'Replace an existing note with the same derived id instead of creating a new one.',
          },
        },
        required: ['title', 'content'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } },
            created: { type: 'string' },
            updated: { type: 'string' },
            bytes: { type: 'integer' },
            createdNew: { type: 'boolean' },
            path: { type: 'string' },
          },
          required: ['id', 'title', 'tags', 'created', 'updated', 'bytes', 'createdNew', 'path'],
          additionalProperties: false,
        },
        render: (_args, value) =>
          text(
            `${value.createdNew ? 'Saved' : 'Updated'} note \`${value.id}\` (${value.bytes} bytes) → ${value.path}`,
          ),
      },
      async execute(args) {
        expectArgs(args, {
          title: { type: 'string', required: true, min: 1 },
          content: { type: 'string', required: true },
          tags: { type: 'string[]' },
          overwrite: { type: 'boolean' },
        })
        return store.saveNote({
          title: args.title,
          content: args.content,
          tags: args.tags,
          overwrite: args.overwrite === true,
        })
      },
    },
    {
      name: 'note_list',
      description:
        'List notebook notes, newest first. Optionally filter by a single exact tag. Returns ids you can pass ' +
        'to note_read, note_search or note_delete.',
      parameters: {
        type: 'object',
        properties: {
          tag: { type: 'string', description: 'Only notes carrying this tag.' },
          limit: { type: 'integer', description: `Max notes to return (default 50, cap ${config.maxNotes}).` },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            dir: { type: 'string' },
            total: { type: 'integer' },
            returned: { type: 'integer' },
            notes: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  title: { type: 'string' },
                  tags: { type: 'array', items: { type: 'string' } },
                  updated: { type: 'string' },
                  chars: { type: 'integer' },
                },
                required: ['id', 'title', 'tags', 'updated', 'chars'],
                additionalProperties: false,
              },
            },
          },
          required: ['dir', 'total', 'returned', 'notes'],
          additionalProperties: false,
        },
        render: (_args, value) =>
          text(
            value.total === 0
              ? `Notebook is empty (${value.dir}).`
              : `${value.returned}/${value.total} notes in ${value.dir}:\n${value.notes
                  .map(
                    (note) =>
                      `- ${note.id} — ${note.title}` +
                      (note.tags.length > 0 ? ` [${note.tags.join(', ')}]` : '') +
                      ` · ${note.updated.slice(0, 16).replace('T', ' ')} · ${note.chars} chars`,
                  )
                  .join('\n')}`,
          ),
      },
      async execute(args) {
        expectArgs(args, { tag: { type: 'string' }, limit: { type: 'integer' } })
        const limit = Number.isInteger(args.limit) && args.limit > 0 ? Math.min(args.limit, config.maxNotes) : 50
        const wanted = typeof args.tag === 'string' ? args.tag.trim().toLowerCase() : ''
        const all = await store.listNotes()
        const filtered = wanted.length === 0 ? all : all.filter((note) => note.tags.some((tag) => tag.toLowerCase() === wanted))
        return {
          dir: store.dir,
          total: filtered.length,
          returned: Math.min(filtered.length, limit),
          notes: filtered.slice(0, limit).map((note) => ({
            id: note.id,
            title: note.title,
            tags: note.tags,
            updated: note.updated,
            chars: note.content.length,
          })),
        }
      },
    },
    {
      name: 'note_read',
      description: 'Read one notebook note by id, including its full markdown body, tags and timestamps.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Note id from note_list or note_save.' } },
        required: ['id'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } },
            created: { type: 'string' },
            updated: { type: 'string' },
            chars: { type: 'integer' },
            content: { type: 'string' },
          },
          required: ['id', 'title', 'tags', 'created', 'updated', 'chars', 'content'],
          additionalProperties: false,
        },
        render: (args, value) =>
          text(`# ${value.title}\n(${args.id}${value.tags.length > 0 ? ` · ${value.tags.join(', ')}` : ''})\n\n${value.content}`),
      },
      async execute(args) {
        expectArgs(args, { id: { type: 'string', required: true, min: 1 } })
        const note = await store.readNote(args.id)
        return {
          id: note.id,
          title: note.title,
          tags: note.tags,
          created: note.created,
          updated: note.updated,
          chars: note.content.length,
          content: note.content,
        }
      },
    },
    {
      name: 'note_search',
      description:
        'Case-insensitive substring search across note titles and bodies, optionally restricted to one tag. ' +
        'Returns matching lines with their line numbers so you can quote them directly.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Literal text to look for (case-insensitive).' },
          tag: { type: 'string', description: 'Only search notes carrying this tag.' },
          limit: { type: 'integer', description: 'Max matching lines to return (default 20, cap 100).' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            notesMatched: { type: 'integer' },
            truncated: { type: 'boolean' },
            matches: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  title: { type: 'string' },
                  line: { type: 'integer' },
                  text: { type: 'string' },
                },
                required: ['id', 'title', 'line', 'text'],
                additionalProperties: false,
              },
            },
          },
          required: ['query', 'notesMatched', 'truncated', 'matches'],
          additionalProperties: false,
        },
        render: (_args, value) =>
          text(
            value.matches.length === 0
              ? `No note matches "${value.query}".`
              : `${value.matches.length} line hit(s) in ${value.notesMatched} note(s)${value.truncated ? ' (truncated)' : ''}:\n` +
                  value.matches.map((hit) => `${hit.id}:${hit.line}  ${hit.text}`).join('\n'),
          ),
      },
      async execute(args) {
        expectArgs(args, {
          query: { type: 'string', required: true, min: 1 },
          tag: { type: 'string' },
          limit: { type: 'integer' },
        })
        const limit = Number.isInteger(args.limit) && args.limit > 0 ? Math.min(args.limit, 100) : 20
        const result = await store.searchNotes({ query: args.query, tag: args.tag, limit })
        return { query: args.query, ...result }
      },
    },
    {
      name: 'note_delete',
      description: 'Delete one notebook note by id. The note file is removed from disk.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Note id to delete.' } },
        required: ['id'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            deleted: { type: 'boolean' },
          },
          required: ['id', 'title', 'deleted'],
          additionalProperties: false,
        },
        render: (_args, value) => text(`Deleted note \`${value.id}\` (${value.title}).`),
      },
      async execute(args) {
        expectArgs(args, { id: { type: 'string', required: true, min: 1 } })
        const result = await store.deleteNote(args.id)
        return { id: result.id, title: result.title, deleted: true }
      },
    },
  ]
}

/* ------------------------------------------------------------------ command */

async function runCommand(store, config, rawInput) {
  const input = rawInput.trim()
  const [head, ...rest] = input.split(/\s+/u)
  const tail = rest.join(' ').trim()

  if (input.length === 0 || head === 'list') {
    const notes = await store.listNotes()
    const wanted = head === 'list' ? tail.toLowerCase() : ''
    const shown = wanted.length === 0 ? notes : notes.filter((note) => note.tags.some((tag) => tag.toLowerCase() === wanted))
    if (shown.length === 0) {
      return { kind: 'success', text: `Notebook empty${wanted ? ` for tag "${wanted}"` : ''} · ${store.dir}` }
    }
    return {
      kind: 'success',
      text: `${shown.length} note(s) · ${store.dir}\n\n${shown
        .map(
          (note) =>
            `- ${note.id} — ${note.title}` +
            (note.tags.length > 0 ? ` [${note.tags.join(', ')}]` : '') +
            ` · ${note.updated.slice(0, 16).replace('T', ' ')}`,
        )
        .join('\n')}`,
    }
  }

  if (head === 'help') {
    return {
      kind: 'success',
      text: [
        '/note — list notes',
        '/note list [tag] — list, optionally filtered',
        '/note read <id> (or /note <id>) — print one note',
        '/note save <title> | <content> — save without the model',
        '/note search <text> — find matching lines',
        '/note del <id> — delete one note',
        `/dir: ${store.dir} · limit ${config.maxNotes} notes, ${config.maxNoteBytes} bytes each`,
      ].join('\n'),
    }
  }

  if (head === 'read') {
    if (tail.length === 0) return { kind: 'error', text: 'usage: /note read <id>' }
    try {
      const note = await store.readNote(tail.split(/\s+/u)[0])
      return {
        kind: 'success',
        text: `# ${note.title}\n${note.tags.length > 0 ? `tags: ${note.tags.join(', ')}\n` : ''}updated: ${note.updated}\n\n${note.content}`,
      }
    } catch (error) {
      return { kind: 'error', text: String(error && error.message ? error.message : error) }
    }
  }

  if (head === 'save') {
    const splitAt = tail.indexOf('|')
    if (splitAt === -1) return { kind: 'error', text: 'usage: /note save <title> | <content>' }
    const title = tail.slice(0, splitAt).trim()
    const content = tail.slice(splitAt + 1).trim()
    if (title.length === 0) return { kind: 'error', text: 'title must not be blank' }
    try {
      const saved = await store.saveNote({ title, content, tags: [], overwrite: true })
      return { kind: 'success', text: `Saved \`${saved.id}\` (${saved.bytes} bytes) → ${saved.path}` }
    } catch (error) {
      return { kind: 'error', text: String(error && error.message ? error.message : error) }
    }
  }

  if (head === 'search') {
    if (tail.length === 0) return { kind: 'error', text: 'usage: /note search <text>' }
    const result = await store.searchNotes({ query: tail, limit: 20 })
    if (result.matches.length === 0) return { kind: 'success', text: `No match for "${tail}".` }
    return {
      kind: 'success',
      text: `${result.matches.length} hit(s) in ${result.notesMatched} note(s):\n${result.matches
        .map((hit) => `${hit.id}:${hit.line}  ${hit.text}`)
        .join('\n')}`,
    }
  }

  if (head === 'del' || head === 'delete' || head === 'rm') {
    if (tail.length === 0) return { kind: 'error', text: 'usage: /note del <id>' }
    try {
      const removed = await store.deleteNote(tail.split(/\s+/u)[0])
      return { kind: 'success', text: `Deleted \`${removed.id}\` (${removed.title}).` }
    } catch (error) {
      return { kind: 'error', text: String(error && error.message ? error.message : error) }
    }
  }

  // Bare `/note <id>` reads that note.
  try {
    const note = await store.readNote(head)
    return {
      kind: 'success',
      text: `# ${note.title}\n${note.tags.length > 0 ? `tags: ${note.tags.join(', ')}\n` : ''}updated: ${note.updated}\n\n${note.content}`,
    }
  } catch {
    return { kind: 'error', text: `unknown subcommand "${head}" — try /note help` }
  }
}

/* -------------------------------------------------------------------- apply */

/**
 * Cordis entry point.
 * @param ctx plugin context carrying the host services named in {@link inject}.
 * @param config optional `{ dir, maxNotes, maxNoteBytes }`.
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  const store = createStore(resolved)

  for (const tool of makeTools(store, resolved)) {
    ctx.tools.register(tool)
  }

  ctx.commands.register({
    name: 'note',
    description: 'Read and write the local markdown notebook',
    input: {
      hint: '[list [tag] | read <id> | save <title> | <content> | search <text> | del <id> | help]',
      attachments: false,
    },
    handler: (invocation) => runCommand(store, resolved, String(invocation && invocation.rawInput ? invocation.rawInput : '')),
  })

  // Exposed for tests and for `/note help`; harmless for the host.
  return { dir: resolved.dir, tools: makeTools(store, resolved).map((tool) => tool.name) }
}

export default { name, inject, apply }
