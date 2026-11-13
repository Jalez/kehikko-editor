import type { Reply } from 'kehikot-module-protocol/serve'

import { definition } from './definition.ts'
import { locate } from './open.ts'
import { rankFiles } from './quick.ts'
import { SEARCHES } from './search.ts'
import { MAX_BYTES, MAX_PATH, str } from './shape.ts'
import { outline, projectSymbols } from './symbols.ts'
import { walk } from './walk.ts'
import { withheldFrom } from './withheld.ts'

/**
 * The page's code-navigation routes: quick open, search in project, go to
 * definition, and the two symbol lists. The ticket was checked by `answer` in
 * doors.ts before any of this runs; the project is resolved by its `pageRoot`
 * (the host's answer, then the fence's), passed in.
 *
 * Every path in an answer is project-relative, inside the root, and never a file
 * withheld from the page. Every field of a request is bounded.
 */

export type PageRoot = (named: string) => Promise<{ ok: true; root: string } | { ok: false; reply: Reply }>

const ok = (body: Record<string, unknown>): Reply => ({ status: 200, body: { ok: true, ...body } })
const bad = (why: string, status = 400): Reply => ({ status, body: { ok: false, error: why } })

const MAX_QUERY = 1000
const MAX_GLOBS = 32
const MAX_GLOB = 256
const MAX_ID = 128

function count(value: unknown, fallback: number, max: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN
  if (!Number.isFinite(n)) return fallback
  return Math.max(1, Math.min(max, Math.floor(n)))
}

/** A query string as typed: not trimmed (a search for a leading space is a search), bounded. */
function typed(value: unknown, max: number): string | null {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string' || value.length > max) return null
  return value
}

function globs(value: unknown): string[] | null {
  if (value === undefined || value === null) return []
  const list = typeof value === 'string' ? [value] : value
  if (!Array.isArray(list) || list.length > MAX_GLOBS) return null
  const out: string[] = []
  for (const one of list) {
    if (typeof one !== 'string' || one.length > MAX_GLOB) return null
    if (one.trim()) out.push(one)
  }
  return out
}

/** The answer to one of these routes, or null for any other path. */
export async function answerIntel(
  method: string,
  path: string,
  query: URLSearchParams,
  body: Record<string, unknown> | null,
  pageRoot: PageRoot,
): Promise<Reply | null> {
  if (path === '/api/files' && method === 'GET') {
    const project = await pageRoot(str(query.get('projectPath'), MAX_PATH))
    if (!project.ok) return project.reply
    const asked = typed(query.get('query'), MAX_QUERY)
    if (asked === null) return bad('That is too long to look for.')
    const walked = walk(project.root)
    const files = rankFiles(walked.files, asked, count(query.get('limit'), 50, 500))
    return ok({ files, truncated: walked.truncated })
  }

  if (path === '/api/search' && method === 'POST') {
    if (!body) return bad('That was not a request.')
    const project = await pageRoot(str(body.projectPath, MAX_PATH))
    if (!project.ok) return project.reply
    const asked = typed(body.query, MAX_QUERY)
    if (asked === null) return bad('That is too long to search for.')
    const include = globs(body.include)
    const exclude = globs(body.exclude)
    if (include === null || exclude === null) return bad(`At most ${MAX_GLOBS} file patterns of ${MAX_GLOB} characters each.`)
    const id = str(body.searchId, MAX_ID) || 'default'
    const result = await SEARCHES.run(`${project.root}\0${id}`, project.root, {
      query: asked,
      caseSensitive: body.caseSensitive === true,
      wholeWord: body.wholeWord === true,
      regex: body.regex === true,
      include,
      exclude,
    })
    return ok({ ...result })
  }

  if (path === '/api/definition' && method === 'POST') {
    if (!body) return bad('That was not a request.')
    const project = await pageRoot(str(body.projectPath, MAX_PATH))
    if (!project.ok) return project.reply
    const at = str(body.path, MAX_PATH)
    if (!at) return bad('Nothing named a file.')
    const where = locate(project.root, at, 'page')
    if (!where.ok) return bad(where.error, 404)
    const text = pageText(body.text)
    if (text === null) return bad('That text is larger than the Editor opens.', 413)
    const offset = typeof body.offset === 'number' && Number.isFinite(body.offset) ? Math.max(0, Math.floor(body.offset)) : null
    if (offset === null) return bad('Nothing said where in the file to look.')
    const found = await definition(project.root, where.relative, offset, text)
    const targets = found.targets.filter((one) => !withheldFrom(one.relative, 'page'))
    return ok({ targets, via: targets.length ? found.via : null, said: targets.length ? found.said : found.said ?? 'No definition found.' })
  }

  if (path === '/api/outline' && method === 'POST') {
    if (!body) return bad('That was not a request.')
    const project = await pageRoot(str(body.projectPath, MAX_PATH))
    if (!project.ok) return project.reply
    const at = str(body.path, MAX_PATH)
    if (!at) return bad('Nothing named a file.')
    const where = locate(project.root, at, 'page')
    if (!where.ok) return bad(where.error, 404)
    const text = pageText(body.text)
    if (text === null) return bad('That text is larger than the Editor opens.', 413)
    return ok({ symbols: outline(project.root, where.relative, text) })
  }

  if (path === '/api/symbols' && method === 'GET') {
    const project = await pageRoot(str(query.get('projectPath'), MAX_PATH))
    if (!project.ok) return project.reply
    const asked = typed(query.get('query'), MAX_QUERY)
    if (asked === null) return bad('That is too long to look for.')
    const found = await projectSymbols(project.root, asked, count(query.get('limit'), 100, 500))
    const symbols = found
      .filter((one) => !withheldFrom(one.relative, 'page'))
      .map(({ name, kind, relative, line, column, container, hits }) => ({ name, kind, relative, line, column, container, hits }))
    return ok({ symbols })
  }

  return null
}

/** The page's unsaved text: undefined when not sent, null when it is not text or too large. */
function pageText(value: unknown): string | undefined | null {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') return null
  if (value.length > MAX_BYTES || Buffer.byteLength(value, 'utf8') > MAX_BYTES) return null
  return value
}
