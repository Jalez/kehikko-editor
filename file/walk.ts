import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync, type Dirent } from 'node:fs'
import { join, relative } from 'node:path'

import { contains } from './confine.ts'
import { withheldFrom } from './withheld.ts'

/**
 * Every file of a project the page may look at, as one bounded list: what quick
 * open ranks, what search reads and what the text fallbacks of definition and
 * symbols scan.
 *
 * The fence holds here exactly as it holds for one file: a symlink whose real
 * path leaves the root is skipped (a link inside the root is followed, once), the
 * folders and keys the page never shows (`withheld.ts`) are skipped, and so are
 * `.git` and `node_modules`. `.kehikot` is listed: it is read-only in the editor,
 * not hidden.
 *
 * `.gitignore` files are honoured, root and nested, plus `.git/info/exclude`.
 * When the root is a git work tree and git answers within the time limit, git's
 * own list (`ls-files -co --exclude-standard`) is used instead of the in-process
 * walk, and filtered through the same rules; any failure falls back to the walk.
 */

export interface Walked {
  /** Project-relative, forward slashes, sorted. */
  files: string[]
  /** True when the bound or the time limit cut the list short. */
  truncated: boolean
}

export interface WalkOptions {
  maxFiles?: number
  timeMs?: number
  /** Ask git when the root is a work tree. On by default. */
  git?: boolean
  /** Ignore the cache. */
  fresh?: boolean
}

export const MAX_FILES = 20_000
export const WALK_MS = 1500
const CACHE_MS = 10_000

/** Never descended into, whatever a .gitignore says. */
const NEVER = new Set(['.git', 'node_modules'])

const cache = new Map<string, { at: number; key: string; walked: Walked }>()

/** For tests: forget every cached walk. */
export function forgetWalks(): void {
  cache.clear()
}

/** The files of a project, from the cache when it is fresh. `root` is a real path from `rootOf`. */
export function walk(root: string, options: WalkOptions = {}): Walked {
  const maxFiles = options.maxFiles ?? MAX_FILES
  const timeMs = options.timeMs ?? WALK_MS
  const useGit = options.git ?? true
  const key = `${maxFiles}:${timeMs}:${useGit}`
  const cached = cache.get(root)
  if (!options.fresh && cached && cached.key === key && Date.now() - cached.at < CACHE_MS) return cached.walked
  const deadline = Date.now() + timeMs
  const walked = (useGit ? fromGit(root, maxFiles, deadline) : null) ?? fromDisk(root, maxFiles, deadline)
  if (cache.size > 16) cache.clear()
  cache.set(root, { at: Date.now(), key, walked })
  return walked
}

/* ------------------------------------------------------------------ *
 * git's list
 * ------------------------------------------------------------------ */

function fromGit(root: string, maxFiles: number, deadline: number): Walked | null {
  if (!existsSync(join(root, '.git'))) return null
  const left = deadline - Date.now()
  if (left < 100) return null
  let out: Buffer
  try {
    const ran = spawnSync('git', ['-c', 'core.quotepath=off', 'ls-files', '-co', '--exclude-standard', '-z'], {
      cwd: root,
      timeout: Math.min(left, 1000),
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    if (ran.status !== 0 || ran.error || !ran.stdout) return null
    out = ran.stdout
  } catch {
    return null
  }
  const files: string[] = []
  const seen = new Set<string>()
  let truncated = false
  for (const one of out.toString('utf8').split('\0')) {
    if (!one || seen.has(one)) continue
    seen.add(one)
    if (Date.now() > deadline || files.length >= maxFiles) {
      truncated = true
      break
    }
    if (one.split('/').some((segment) => NEVER.has(segment)) || withheldFrom(one, 'page')) continue
    let stat
    try {
      stat = lstatSync(join(root, one))
    } catch {
      /* Tracked and deleted from the working tree. */
      continue
    }
    if (stat.isSymbolicLink()) {
      if (!linkedFileInside(root, one)) continue
    } else if (!stat.isFile()) continue
    files.push(one)
  }
  files.sort()
  return { files, truncated }
}

/** A symlinked file is listed when its real path is a file inside the root and not withheld. */
function linkedFileInside(root: string, rel: string): boolean {
  try {
    const real = realpathSync(join(root, rel))
    if (!contains(root, real) || real === root) return false
    if (withheldFrom(relative(root, real), 'page')) return false
    return statSync(real).isFile()
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ *
 * The in-process walk
 * ------------------------------------------------------------------ */

function fromDisk(root: string, maxFiles: number, deadline: number): Walked {
  const files: string[] = []
  const visited = new Set<string>([root])
  const base: Rule[] = [...rulesFrom(readText(join(root, '.git', 'info', 'exclude')), '')]
  const stack: { rel: string; rules: Rule[] }[] = [{ rel: '', rules: base }]
  let truncated = false

  outer: while (stack.length) {
    const { rel, rules: inherited } = stack.pop()!
    const dir = rel ? join(root, rel) : root
    const rules = [...inherited, ...rulesFrom(readText(join(dir, '.gitignore')), rel)]
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    const dirs: string[] = []
    for (const entry of entries) {
      if (Date.now() > deadline || files.length >= maxFiles) {
        truncated = true
        break outer
      }
      if (NEVER.has(entry.name)) continue
      const child = rel ? `${rel}/${entry.name}` : entry.name
      if (withheldFrom(child, 'page')) continue
      let isDir = entry.isDirectory()
      let isFile = entry.isFile()
      if (entry.isSymbolicLink()) {
        let real: string
        try {
          real = realpathSync(join(dir, entry.name))
        } catch {
          continue
        }
        /* The fence: a link that leaves the root is not followed and not listed. */
        if (real === root || !contains(root, real)) continue
        if (withheldFrom(relative(root, real), 'page')) continue
        try {
          const stat = statSync(real)
          isDir = stat.isDirectory()
          isFile = stat.isFile()
        } catch {
          continue
        }
        if (isDir) {
          if (visited.has(real)) continue
          visited.add(real)
        }
      }
      if (ignored(rules, child, isDir)) continue
      if (isDir) dirs.push(child)
      else if (isFile) files.push(child)
    }
    /* Reverse, so the stack pops them in name order. */
    for (let i = dirs.length - 1; i >= 0; i -= 1) stack.push({ rel: dirs[i]!, rules })
  }
  files.sort()
  return { files, truncated }
}

function readText(path: string): string {
  try {
    const stat = statSync(path)
    if (!stat.isFile() || stat.size > 256 * 1024) return ''
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/* ------------------------------------------------------------------ *
 * .gitignore, the common subset
 * ------------------------------------------------------------------ */

export interface Rule {
  /** The folder the rule's file is in, project-relative, '' for the root. */
  base: string
  regex: RegExp
  negate: boolean
  dirOnly: boolean
  /** Matched against the whole path below `base`; otherwise against the name alone. */
  anchored: boolean
}

/** The rules of one .gitignore file in folder `base`. */
export function rulesFrom(text: string, base: string): Rule[] {
  const rules: Rule[] = []
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.replace(/(?<!\\)\s+$/, '')
    if (!line || line.startsWith('#')) continue
    let negate = false
    if (line.startsWith('!')) {
      negate = true
      line = line.slice(1)
    } else if (line.startsWith('\\!') || line.startsWith('\\#')) line = line.slice(1)
    let dirOnly = false
    if (line.endsWith('/')) {
      dirOnly = true
      line = line.replace(/\/+$/, '')
    }
    if (!line) continue
    const anchored = line.includes('/')
    if (line.startsWith('/')) line = line.slice(1)
    if (line.startsWith('**/')) {
      /* `**\/name` is a name at any depth: the unanchored form, which also matches nested paths below. */
      const rest = line.slice(3)
      if (!rest.includes('/')) {
        rules.push({ base, regex: new RegExp(`^${globToRegex(rest)}$`), negate, dirOnly, anchored: false })
        continue
      }
    }
    rules.push({ base, regex: new RegExp(`^${globToRegex(line)}$`), negate, dirOnly, anchored })
  }
  return rules
}

/** Whether a project-relative path is ignored: the last rule that matches decides. */
export function ignored(rules: Rule[], rel: string, isDir: boolean): boolean {
  let out = false
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) continue
    let below: string
    if (!rule.base) below = rel
    else if (rel.startsWith(`${rule.base}/`)) below = rel.slice(rule.base.length + 1)
    else continue
    const subject = rule.anchored ? below : below.slice(below.lastIndexOf('/') + 1)
    if (rule.regex.test(subject)) out = !rule.negate
  }
  return out
}

/**
 * A glob as the source of a regular expression: `**` crosses folders, `*` and `?`
 * do not, `[...]` is a class, `{a,b}` is a choice. Everything else is literal.
 */
export function globToRegex(glob: string): string {
  let out = ''
  let i = 0
  let braces = 0
  while (i < glob.length) {
    const c = glob[i]!
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const before = i === 0 || glob[i - 1] === '/'
        let j = i + 2
        while (glob[j] === '*') j += 1
        if (before && glob[j] === '/') {
          out += '(?:.*/)?'
          i = j + 1
          continue
        }
        if (before && j === glob.length) {
          out += '.*'
          i = j
          continue
        }
        out += '.*'
        i = j
        continue
      }
      out += '[^/]*'
    } else if (c === '?') out += '[^/]'
    else if (c === '[') {
      const end = glob.indexOf(']', i + 2)
      if (end === -1) out += '\\['
      else {
        let body = glob.slice(i + 1, end)
        if (body.startsWith('!')) body = `^${body.slice(1)}`
        out += `[${body.replace(/\\/g, '\\\\')}]`
        i = end
      }
    } else if (c === '{') {
      braces += 1
      out += '(?:'
    } else if (c === '}' && braces > 0) {
      braces -= 1
      out += ')'
    } else if (c === ',' && braces > 0) out += '|'
    else if (c === '\\' && i + 1 < glob.length) {
      i += 1
      out += escape(glob[i]!)
    } else out += escape(c)
    i += 1
  }
  while (braces-- > 0) out += ')'
  return out
}

function escape(c: string): string {
  return /[.*+?^${}()|[\]\\/]/.test(c) ? `\\${c}` : c
}
