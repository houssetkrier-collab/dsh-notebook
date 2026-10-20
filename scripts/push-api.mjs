#!/usr/bin/env node
/**
 * Push the current HEAD to GitHub through the REST API instead of the git
 * transport.
 *
 * Why this exists: on some networks `github.com:443` (git-upload-pack) is
 * blackholed while `api.github.com` works, so `git push` dies with
 * "Could not connect to server" even though gh is authenticated. This walks the
 * same objects git would send — blobs, one tree, one commit — and moves the
 * branch ref, then checks every sha it produced against the local repository.
 *
 *   node scripts/push-api.mjs                 # push HEAD to origin's default branch
 *   node scripts/push-api.mjs --branch main   # explicit branch name
 *   node scripts/push-api.mjs --dry-run       # build objects, change nothing
 *
 * Requires: git in PATH, and `gh auth token` (or GITHUB_TOKEN) with repo scope.
 */

import { execFileSync } from 'node:child_process'
import path from 'node:path'

const API = 'https://api.github.com'

/* ------------------------------------------------------------------- setup */

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const value = (name, fallback = undefined) => {
  const at = argv.indexOf(`--${name}`)
  return at === -1 || at === argv.length - 1 ? fallback : argv[at + 1]
}

function git(...args) {
  return execFileSync('git', args, { maxBuffer: 512 * 1024 * 1024 })
}

const token = process.env.GITHUB_TOKEN
  ?? execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim()
if (!token) throw new Error('no GitHub token: set GITHUB_TOKEN or run `gh auth login`')

const remote = value('remote', 'origin')
const remoteUrl = git('remote', 'get-url', remote).toString().trim()
const match = /github\.com[:/]([^/]+)\/([^/\s]+?)(?:\.git)?$/u.exec(remoteUrl)
if (!match) throw new Error(`cannot parse a GitHub repository from remote ${remote}: ${remoteUrl}`)
const [, owner, repo] = match
const branch = value('branch', git('rev-parse', '--abbrev-ref', 'HEAD').toString().trim())
if (branch === 'HEAD') throw new Error('detached HEAD: pass --branch <name>')

async function api(route, init = {}) {
  const response = await fetch(`${API}${route}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'dsh-notebook-push-api',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  })
  const text = await response.text()
  const payload = text.length > 0 ? JSON.parse(text) : null
  if (!response.ok) {
    throw new Error(`${init.method ?? 'GET'} ${route} → ${response.status} ${payload?.message ?? text}`)
  }
  return payload
}

/* ------------------------------------------------------------ remote ref */

// Whatever the branch points at right now is this commit's parent, so repeated
// API pushes append to the remote history even when the local clone cannot fetch.
async function remoteHead() {
  try {
    const ref = await api(`/repos/${owner}/${repo}/git/ref/heads/${branch}`)
    return ref.object.sha
  } catch (error) {
    if (String(error.message).includes('404')) return null
    throw error
  }
}

let parent = await remoteHead()

// A brand-new repository rejects the git-data endpoints ("Git Repository is
// empty"), so give it one throwaway commit through the Contents API; the first
// pushed commit carries no parent, leaving that bootstrap commit dangling.
if (parent === null) {
  const remoteInfo = await api(`/repos/${owner}/${repo}`)
  if (remoteInfo.size === 0) {
    const bootstrap = await api(`/repos/${owner}/${repo}/contents/.dsh-bootstrap`, {
      method: 'PUT',
      body: JSON.stringify({
        message: 'bootstrap',
        content: Buffer.from('bootstrap\n', 'utf8').toString('base64'),
        branch,
      }),
    })
    console.log('  empty repository: bootstrapped it so the git-data APIs accept objects')
    parent = bootstrap.commit.sha
  }
}

console.log(`pushing ${owner}/${repo} · ${branch} through the REST API`)
console.log(`  parent: ${parent ? parent.slice(0, 12) : 'none (first commit)'}`)

/* ---------------------------------------------------------------- objects */

// `git ls-tree -r -z` is the exact object list of HEAD, in git's own order.
const entries = git('ls-tree', '-r', '-z', 'HEAD')
  .toString('utf8')
  .split('\0')
  .filter((line) => line.length > 0)
  .map((line) => {
    const tab = line.indexOf('\t')
    const [mode, type, sha] = line.slice(0, tab).split(' ')
    return { mode, type, sha, path: line.slice(tab + 1) }
  })

const localTree = git('rev-parse', 'HEAD^{tree}').toString().trim()
const localCommit = git('rev-parse', 'HEAD').toString().trim()
const message = git('log', '-1', '--format=%B').toString()
const [an, ae, ad, cn, ce, cd] = git('log', '-1', '--format=%an%n%ae%n%aI%n%cn%n%ce%n%cI')
  .toString()
  .trim()
  .split('\n')

console.log(`  ${entries.length} files · tree ${localTree.slice(0, 12)} · commit ${localCommit.slice(0, 12)}`)
if (flag('dry-run')) {
  for (const entry of entries) console.log(`  would upload ${entry.mode} ${entry.path}`)
  process.exit(0)
}

const uploaded = []
for (const entry of entries) {
  const blob = git('cat-file', 'blob', entry.sha)
  if (blob.length === 0) throw new Error(`empty blob for ${entry.path}`)
  // Blob shas are content-addressed, so git and the API must agree on them.
  const { sha } = await api(`/repos/${owner}/${repo}/git/blobs`, {
    method: 'POST',
    body: JSON.stringify({ content: blob.toString('base64'), encoding: 'base64' }),
  })
  if (sha !== entry.sha) throw new Error(`blob sha mismatch for ${entry.path}: ${sha} != ${entry.sha}`)
  uploaded.push({ path: entry.path, mode: entry.mode, type: 'blob', sha })
  process.stdout.write(`\r  uploaded ${uploaded.length}/${entries.length}`)
}
process.stdout.write('\n')

const tree = await api(`/repos/${owner}/${repo}/git/trees`, {
  method: 'POST',
  body: JSON.stringify({ tree: uploaded }),
})
if (tree.sha !== localTree) throw new Error(`tree sha mismatch: ${tree.sha} != ${localTree}`)

const commit = await api(`/repos/${owner}/${repo}/git/commits`, {
  method: 'POST',
  body: JSON.stringify({
    message,
    tree: tree.sha,
    parents: parent ? [parent] : [],
    author: { name: an, email: ae, date: ad },
    committer: { name: cn, email: ce, date: cd },
  }),
})
if (commit.sha !== localCommit) {
  // Not fatal: GitHub normalises identities and times, so the commit sha can
  // differ even when the tree (and therefore every file) is identical. Blob and
  // tree shas above are the real integrity check.
  console.warn(`  note: commit sha differs (${commit.sha.slice(0, 12)} vs local ${localCommit.slice(0, 12)}; tree shas match)`)
}

let ref = null
try {
  ref = await api(`/repos/${owner}/${repo}/git/ref/heads/${branch}`)
} catch (error) {
  if (!String(error.message).includes('404')) throw error
}

if (ref) {
  if (ref.object.sha === commit.sha) {
    console.log(`  ref refs/heads/${branch} already at ${commit.sha.slice(0, 12)}`)
  } else {
    const updated = await api(`/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
      method: 'PATCH',
      body: JSON.stringify({ sha: commit.sha, force: true }),
      headers: { Authorization: `Bearer ${token}` },
    })
    console.log(`  moved refs/heads/${branch}: ${ref.object.sha.slice(0, 12)} → ${updated.object.sha.slice(0, 12)}`)
  }
} else {
  const created = await api(`/repos/${owner}/${repo}/git/refs`, {
    method: 'POST',
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha }),
  })
  console.log(`  created refs/heads/${branch} at ${created.object.sha.slice(0, 12)}`)
}

const finalInfo = await api(`/repos/${owner}/${repo}`)
console.log(`\ndone: ${finalInfo.html_url}/tree/${branch} (${finalInfo.visibility})`)
console.log('every file now matches this HEAD (blob and tree shas verified); the commit sha can differ from the local one.')
