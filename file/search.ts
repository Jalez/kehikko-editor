import { closeSync, fstatSync, openSync, readSync } from 'node:fs'

import { inside } from './confine.ts'
import { SNIFF_BYTES, binary } from './shape.ts'
import { globToRegex, walk } from './walk.ts'
import { withheldFrom } from './withheld.ts'

/**
 * Search in project: every line of every file the walk lists that matches.
 *
 * The walk's list is the whole of what is read, so `.gitignore`, `.git`,
 * `node_modules`, the withheld files and the fence hold here as they hold there;
 * each file is put through the fence once more as it is opened. A binary file and
 * a file over the size bound are skipped. Everything is bounded: results, bytes
 * per file, time. A newer search under the same key cancels the older one.
 */

export interface SearchQuery {
  query: string
  caseSensitive?: boolean
  wholeWord?: boolean
  regex?: boolean
  include?: string[]
  exclude?: string[]
}

export interface SearchLimits {
  maxResults?: number
  maxFileBytes?: number
  timeMs?: number
  signal?: { cancelled: boolean }
}

export interface Match {
  /** 1-based. */
  line: number
  /** 0-based, in UTF-16 code units. */
  column: number
  length: number
  /** The line, or a window of it around the match. */
  preview: string
  /** Where `preview` starts within the line. */
  previewStart: number
}

export interface FileMatches {
  relative: string
  count: number
  matches: Match[]
}

export interface SearchResult {
  files: FileMatches[]
  total: number
  truncated: boolean
  timedOut: boolean
  cancelled: boolean
  error?: string
}

export const MAX_RESULTS = 2000
export const MAX_FILE_BYTES = 1_048_576
export const SEARCH_MS = 3000
const PREVIEW = 240
const BEFORE = 60
/** Files read between yields to the event loop, so a newer request can arrive and cancel this one. */
const YIELD_EVERY = 25

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

/** The expression a query searches with, or a sentence why it cannot be one. */
export function patternOf(query: SearchQuery): RegExp | string {
  let source = query.regex ? query.query : escapeRegex(query.query)
  if (query.wholeWord) source = `\\b(?:${source})\\b`
  try {
    return new RegExp(source, query.caseSensitive ? 'g' : 'gi')
  } catch (e) {
    const reason = e instanceof Error ? e.message.replace(/^Invalid regular expression:\s*/i, '') : String(e)
    return `That is not a valid regular expression: ${reason}`
  }
}

export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Globs as the search box takes them, each relative to the project: `src/**`,
 * `*.ts`, several in one entry separated by commas. A pattern without a slash
 * matches at any depth, and a bare name (`foo`) also matches everything under a
 * folder of that name, as `**\/foo/**`.
 */
export function globMatcher(globs: string[]): ((relative: string) => boolean) | null {
  const regexes: RegExp[] = []
  for (const entry of globs) {
    for (let glob of splitCommas(entry)) {
      glob = glob.trim().replace(/^\.\//, '')
      if (!glob) continue
      if (glob.endsWith('/')) glob += '**'
      const anchored = glob.startsWith('/') || glob.slice(0, -1).includes('/')
      if (glob.startsWith('/')) glob = glob.slice(1)
      const body = globToRegex(glob)
      const prefix = anchored ? '' : '(?:.*/)?'
      regexes.push(new RegExp(`^${prefix}${body}(?:/.*)?$`))
    }
  }
  if (!regexes.length) return null
  return (relative) => regexes.some((regex) => regex.test(relative))
}

function splitCommas(entry: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < entry.length; i += 1) {
    const c = entry[i]
    if (c === '{') depth += 1
    else if (c === '}' && depth > 0) depth -= 1
    else if (c === ',' && depth === 0) {
      out.push(entry.slice(start, i))
      start = i + 1
    }
  }
  out.push(entry.slice(start))
  return out
}

/** A text file's contents through the fence, or null: outside, gone, too big, binary or withheld. */
export function readText(root: string, relative: string, maxBytes: number): string | null {
  if (withheldFrom(relative, 'page')) return null
  const real = inside(root, relative)
  if (real === null) return null
  let fd: number
  try {
    fd = openSync(real, 'r')
  } catch {
    return null
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > maxBytes) return null
    const buffer = Buffer.alloc(stat.size)
    let got = 0
    while (got < buffer.length) {
      const n = readSync(fd, buffer, got, buffer.length - got, got)
      if (n <= 0) break
      got += n
    }
    const bytes = buffer.subarray(0, got)
    if (binary(bytes.subarray(0, SNIFF_BYTES))) return null
    return bytes.toString('utf8')
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}

/** The preview of a line for a match at `column`: the line, or a window of it around the match. */
export function previewOf(line: string, column: number, length: number): { preview: string; previewStart: number } {
  if (line.length <= PREVIEW) {
    const indent = line.length - line.trimStart().length
    const start = Math.min(indent, column)
    return { preview: line.slice(start).trimEnd(), previewStart: start }
  }
  let start = Math.max(0, column - BEFORE)
  const end = Math.min(line.length, Math.max(start + PREVIEW, column + Math.min(length, PREVIEW)))
  start = Math.max(0, Math.min(start, end - PREVIEW))
  return { preview: line.slice(start, end), previewStart: start }
}

/** Search a project. Never throws: a bad expression is `error`, in words. */
export async function searchProject(root: string, query: SearchQuery, limits: SearchLimits = {}): Promise<SearchResult> {
  const maxResults = limits.maxResults ?? MAX_RESULTS
  const maxFileBytes = limits.maxFileBytes ?? MAX_FILE_BYTES
  const deadline = Date.now() + (limits.timeMs ?? SEARCH_MS)
  const signal = limits.signal ?? { cancelled: false }
  const result: SearchResult = { files: [], total: 0, truncated: false, timedOut: false, cancelled: false }
  if (!query.query) return result

  const pattern = patternOf(query)
  if (typeof pattern === 'string') return { ...result, error: pattern }
  let include: ((relative: string) => boolean) | null
  let exclude: ((relative: string) => boolean) | null
  try {
    include = globMatcher(query.include ?? [])
    exclude = globMatcher(query.exclude ?? [])
  } catch {
    return { ...result, error: 'One of the file patterns could not be read as a pattern.' }
  }

  const walked = walk(root)
  result.truncated = walked.truncated
  let read = 0
  for (const relative of walked.files) {
    if (include && !include(relative)) continue
    if (exclude && exclude(relative)) continue
    if (read > 0 && read % YIELD_EVERY === 0) await tick()
    if (signal.cancelled) {
      result.cancelled = true
      break
    }
    if (Date.now() > deadline) {
      result.timedOut = true
      break
    }
    read += 1
    const text = readText(root, relative, maxFileBytes)
    if (text === null) continue
    const found = matchText(text, pattern, maxResults - result.total, !query.regex)
    if (found.matches.length) {
      result.files.push({ relative, count: found.matches.length, matches: found.matches })
      result.total += found.matches.length
    }
    if (found.more || result.total >= maxResults) {
      result.truncated = true
      break
    }
  }
  return result
}

/** Every match of `pattern` in `text`, line by line, at most `room`. */
export function matchText(text: string, pattern: RegExp, room: number, literal = false): { matches: Match[]; more: boolean } {
  const matches: Match[] = []
  if (room <= 0) return { matches, more: true }
  /* A literal is tested on the whole text first: most files do not match at all. (An expression may anchor to a line.) */
  pattern.lastIndex = 0
  if (literal && !pattern.test(text)) {
    pattern.lastIndex = 0
    return { matches, more: false }
  }
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!
    pattern.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = pattern.exec(line)) !== null) {
      if (m[0].length === 0) {
        pattern.lastIndex += 1
        if (pattern.lastIndex > line.length) break
        continue
      }
      if (matches.length >= room) return { matches, more: true }
      matches.push({ line: i + 1, column: m.index, length: m[0].length, ...previewOf(line, m.index, m[0].length) })
    }
  }
  return { matches, more: false }
}

/**
 * The searches in flight, by the page's `searchId` and the root. Starting one
 * cancels the one before it under the same key; its loop sees that between files.
 */
export class Searches {
  private live = new Map<string, { cancelled: boolean }>()

  begin(key: string): { cancelled: boolean } {
    const before = this.live.get(key)
    if (before) before.cancelled = true
    const signal = { cancelled: false }
    this.live.set(key, signal)
    if (this.live.size > 64) {
      const oldest = this.live.keys().next().value as string
      this.live.get(oldest)!.cancelled = true
      this.live.delete(oldest)
    }
    return signal
  }

  end(key: string, signal: { cancelled: boolean }): void {
    if (this.live.get(key) === signal) this.live.delete(key)
  }

  /** Run a search under a key, cancelling the one before it. */
  async run(key: string, root: string, query: SearchQuery, limits: Omit<SearchLimits, 'signal'> = {}): Promise<SearchResult> {
    const signal = this.begin(key)
    try {
      return await searchProject(root, query, { ...limits, signal })
    } finally {
      this.end(key, signal)
    }
  }
}

export const SEARCHES = new Searches()
