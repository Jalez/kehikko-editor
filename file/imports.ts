import { readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

import ts from 'typescript'

import { contains, inside } from './confine.ts'
import { walk } from './walk.ts'
import { withheldFrom } from './withheld.ts'

/**
 * Following an import to the file it names, inside the project and nowhere else.
 *
 * Every candidate path goes through the fence (`inside`) before it is stat'd or
 * read, so a specifier, a tsconfig `paths` entry, a package's `exports` or a
 * symlinked package can never lead out of the root, and nothing outside it is
 * read to find out.
 */

export interface Specifier {
  specifier: string
  /** Offsets in the text of the specifier's first character and one past its last (quotes excluded). */
  from: number
  to: number
}

const STRING = /(['"`])((?:\\.|(?!\1)[^\\])*)\1/g
const IMPORT_LINE = /^\s*(?:import\b|export\b[^'"`]*\bfrom\b|}\s*from\b|@import\b)|\bfrom\s*['"`]|\brequire\s*\(|\bimport\s*\(/

/** The module specifier the offset is inside, or the one on an import line the offset is on. */
export function specifierAt(text: string, offset: number): Specifier | null {
  if (offset < 0 || offset > text.length) return null
  const start = text.lastIndexOf('\n', offset - 1) + 1
  let end = text.indexOf('\n', offset)
  if (end === -1) end = text.length
  const line = text.slice(start, end)
  if (line.length > 4096 || !IMPORT_LINE.test(line)) return null
  const strings: Specifier[] = []
  STRING.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = STRING.exec(line)) !== null) {
    const before = line.slice(0, m.index)
    /* Only a string in a specifier's place: after from, import, require( or import(, or @import. */
    if (!/(?:\bfrom|\bimport|\brequire\s*\(|\bimport\s*\(|@import(?:\s+url\()?)\s*$/.test(before)) continue
    const from = start + m.index + 1
    strings.push({ specifier: m[2]!, from, to: from + m[2]!.length })
  }
  if (!strings.length) return null
  const within = strings.find((one) => offset >= one.from - 1 && offset <= one.to + 1)
  return within ?? strings[0]!
}

/* ------------------------------------------------------------------ *
 * Reading inside the root
 * ------------------------------------------------------------------ */

/** A real path inside the root that is a file, or null. */
export function fileInside(root: string, path: string): string | null {
  const real = inside(root, path)
  if (real === null) return null
  try {
    return statSync(real).isFile() ? real : null
  } catch {
    return null
  }
}

function dirInside(root: string, path: string): string | null {
  const real = inside(root, path)
  if (real === null) return null
  try {
    return statSync(real).isDirectory() ? real : null
  } catch {
    return null
  }
}

/** A small JSON (or JSONC) file inside the root, parsed, or null. Comments and trailing commas are tolerated. */
export function readJson(root: string, path: string): Record<string, unknown> | null {
  const real = fileInside(root, path)
  if (real === null) return null
  try {
    if (statSync(real).size > 1024 * 1024) return null
    const parsed = ts.parseConfigFileTextToJson(real, readFileSync(real, 'utf8'))
    return parsed.config && typeof parsed.config === 'object' ? (parsed.config as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const rel = (root: string, real: string) => relative(root, real).split('\\').join('/')

/* ------------------------------------------------------------------ *
 * Probing a path the way TypeScript and bundlers do
 * ------------------------------------------------------------------ */

const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.d.ts', '.js', '.jsx', '.mjs', '.cjs', '.json', '.css', '.scss', '.vue', '.svelte']
const JS_TO_TS: Record<string, string[]> = {
  '.js': ['.ts', '.tsx', '.d.ts'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts', '.d.mts'],
  '.cjs': ['.cts', '.d.cts'],
}

/** The file a path means: as written, with `.js` read as `.ts`, with an extension added, or a folder's entry. */
function probe(root: string, path: string, depth = 0): string | null {
  const real = fileInside(root, path)
  if (real) return real
  for (const [js, tsExts] of Object.entries(JS_TO_TS)) {
    if (!path.endsWith(js)) continue
    for (const one of tsExts) {
      const found = fileInside(root, path.slice(0, -js.length) + one)
      if (found) return found
    }
  }
  for (const ext of EXTENSIONS) {
    const found = fileInside(root, path + ext)
    if (found) return found
  }
  const dir = dirInside(root, path)
  if (dir && depth < 3) {
    const pkg = readJson(root, join(dir, 'package.json'))
    if (pkg) {
      for (const field of ['types', 'typings', 'module', 'main']) {
        const entry = pkg[field]
        if (typeof entry === 'string' && entry) {
          const found = probe(root, join(dir, entry), depth + 1)
          if (found) return found
        }
      }
    }
    for (const ext of EXTENSIONS) {
      const found = fileInside(root, join(dir, `index${ext}`))
      if (found) return found
    }
  }
  return null
}

/* ------------------------------------------------------------------ *
 * tsconfig / jsconfig
 * ------------------------------------------------------------------ */

export interface PathsConfig {
  /** Absolute; where `paths` targets are resolved from. */
  pathsBase: string | null
  paths: Record<string, string[]> | null
  baseUrl: string | null
}

/** The nearest tsconfig.json or jsconfig.json from `dir` up to the root, or null. */
export function nearestConfig(root: string, dir: string): string | null {
  let at = dir
  for (let i = 0; i < 64; i += 1) {
    if (!contains(root, at)) return null
    for (const name of ['tsconfig.json', 'jsconfig.json']) {
      const found = fileInside(root, join(at, name))
      if (found) return found
    }
    if (at === root) return null
    at = dirname(at)
  }
  return null
}

/** `baseUrl` and `paths` from a config and what it extends, within the root. */
export function pathsConfig(root: string, configPath: string, depth = 0): PathsConfig {
  const out: PathsConfig = { pathsBase: null, paths: null, baseUrl: null }
  const config = readJson(root, configPath)
  if (!config || depth > 8) return out
  const dir = dirname(configPath)
  const extended = config.extends
  for (const one of Array.isArray(extended) ? extended : typeof extended === 'string' ? [extended] : []) {
    if (typeof one !== 'string') continue
    const parent = extendedConfig(root, dir, one)
    if (!parent) continue
    const inherited = pathsConfig(root, parent, depth + 1)
    if (inherited.paths) {
      out.paths = inherited.paths
      out.pathsBase = inherited.pathsBase
    }
    if (inherited.baseUrl) out.baseUrl = inherited.baseUrl
  }
  const options = (config.compilerOptions ?? {}) as Record<string, unknown>
  if (typeof options.baseUrl === 'string') out.baseUrl = resolve(dir, options.baseUrl)
  if (options.paths && typeof options.paths === 'object') {
    const paths: Record<string, string[]> = {}
    for (const [key, value] of Object.entries(options.paths as Record<string, unknown>)) {
      if (Array.isArray(value)) paths[key] = value.filter((one): one is string => typeof one === 'string')
    }
    out.paths = paths
    out.pathsBase = dir
  }
  if (out.paths && out.baseUrl) out.pathsBase = out.baseUrl
  return out
}

function extendedConfig(root: string, dir: string, name: string): string | null {
  const candidates =
    name.startsWith('.') || isAbsolute(name)
      ? [resolve(dir, name), resolve(dir, `${name}.json`)]
      : [join(root, 'node_modules', name), join(root, 'node_modules', `${name}.json`), join(root, 'node_modules', name, 'tsconfig.json')]
  for (const one of candidates) {
    const found = fileInside(root, one)
    if (found) return found
  }
  return null
}

function viaPaths(root: string, config: PathsConfig, specifier: string): string | null {
  if (config.paths && config.pathsBase) {
    let best: { key: string; star: string | null } | null = null
    for (const key of Object.keys(config.paths)) {
      const star = key.indexOf('*')
      if (star === -1) {
        if (key === specifier) {
          best = { key, star: null }
          break
        }
        continue
      }
      const prefix = key.slice(0, star)
      const suffix = key.slice(star + 1)
      if (specifier.startsWith(prefix) && specifier.endsWith(suffix) && specifier.length >= prefix.length + suffix.length) {
        if (!best || prefix.length > best.key.indexOf('*')) best = { key, star: specifier.slice(prefix.length, specifier.length - suffix.length) }
      }
    }
    if (best) {
      for (const target of config.paths[best.key] ?? []) {
        const filled = best.star === null ? target : target.replace('*', best.star)
        const found = probe(root, resolve(config.pathsBase, filled))
        if (found) return found
      }
    }
  }
  if (config.baseUrl) return probe(root, resolve(config.baseUrl, specifier))
  return null
}

/* ------------------------------------------------------------------ *
 * Packages
 * ------------------------------------------------------------------ */

/** Which conditions of `exports` are tried, in order: source first, types last. Each candidate must exist. */
const CONDITIONS = ['source', 'import', 'module', 'default', 'require', 'node', 'browser', 'types']

function splitPackage(specifier: string): { name: string; sub: string } | null {
  const parts = specifier.split('/')
  if (specifier.startsWith('@')) {
    if (parts.length < 2 || !parts[1]) return null
    return { name: `${parts[0]}/${parts[1]}`, sub: parts.slice(2).join('/') }
  }
  if (!parts[0]) return null
  return { name: parts[0], sub: parts.slice(1).join('/') }
}

/** The targets a package's `exports` names for a subpath ('.' or './x'), in the order they are tried. */
export function fromExports(exports: unknown, sub: string): string[] {
  if (typeof exports === 'string') return sub === '.' ? [exports] : []
  if (Array.isArray(exports)) return exports.flatMap((one) => fromExports(one, sub))
  if (!exports || typeof exports !== 'object') return []
  const map = exports as Record<string, unknown>
  const keys = Object.keys(map)
  if (keys.length && keys.every((key) => !key.startsWith('.'))) return sub === '.' ? conditions(map) : []
  if (sub in map) return conditions(map[sub])
  /* A subpath pattern: "./*" or "./features/*.js". */
  for (const key of keys) {
    const star = key.indexOf('*')
    if (star === -1) continue
    const prefix = key.slice(0, star)
    const suffix = key.slice(star + 1)
    if (sub.startsWith(prefix) && sub.endsWith(suffix)) {
      const filled = sub.slice(prefix.length, sub.length - suffix.length)
      return conditions(map[key]).map((target) => target.replace('*', filled))
    }
  }
  return []
}

function conditions(value: unknown, depth = 0): string[] {
  if (typeof value === 'string') return [value]
  if (depth > 6 || !value) return []
  if (Array.isArray(value)) return value.flatMap((one) => conditions(one, depth + 1))
  if (typeof value !== 'object') return []
  const map = value as Record<string, unknown>
  return CONDITIONS.filter((key) => key in map).flatMap((key) => conditions(map[key], depth + 1))
}

function inPackage(root: string, dir: string, sub: string): string | null {
  const pkg = readJson(root, join(dir, 'package.json'))
  if (pkg && pkg.exports !== undefined) {
    for (const target of fromExports(pkg.exports, sub ? `./${sub}` : '.').slice(0, 16)) {
      const found = probe(root, resolve(dir, target))
      if (found) return found
    }
  }
  if (sub) return probe(root, join(dir, sub))
  return probe(root, dir)
}

/** Workspace packages by name: every package.json the walk lists, outside node_modules. */
const workspaces = new Map<string, { at: number; byName: Map<string, string> }>()

function workspacePackages(root: string): Map<string, string> {
  const cached = workspaces.get(root)
  if (cached && Date.now() - cached.at < 10_000) return cached.byName
  const byName = new Map<string, string>()
  let seen = 0
  for (const file of walk(root).files) {
    if (file !== 'package.json' && !file.endsWith('/package.json')) continue
    if (++seen > 2000) break
    const pkg = readJson(root, join(root, file))
    if (pkg && typeof pkg.name === 'string' && !byName.has(pkg.name)) byName.set(pkg.name, dirname(join(root, file)))
  }
  if (workspaces.size > 16) workspaces.clear()
  workspaces.set(root, { at: Date.now(), byName })
  return byName
}

/** For tests. */
export function forgetWorkspaces(): void {
  workspaces.clear()
}

/* ------------------------------------------------------------------ *
 * The one entry
 * ------------------------------------------------------------------ */

/** The project-relative file `specifier`, imported from `fromRelative`, names; or null. Never outside the root. */
export function resolveImport(root: string, fromRelative: string, specifier: string): string | null {
  const real = resolveReal(root, fromRelative, specifier)
  if (real === null || !contains(root, real) || real === root) return null
  const out = rel(root, real)
  return withheldFrom(out, 'page') ? null : out
}

function resolveReal(root: string, fromRelative: string, raw: string): string | null {
  const specifier = raw.replace(/[?#].*$/, '').trim()
  if (!specifier || specifier.length > 1024 || specifier.includes('\0')) return null
  const fromDir = dirname(resolve(root, fromRelative))
  if (!contains(root, fromDir)) return null

  if (specifier.startsWith('./') || specifier.startsWith('../') || specifier === '.' || specifier === '..') {
    return probe(root, resolve(fromDir, specifier))
  }
  /* A leading slash is the project's root, as bundlers read it. */
  if (specifier.startsWith('/')) return probe(root, join(root, specifier.slice(1)))
  if (/^[a-z][a-z0-9+.-]*:/i.test(specifier) && !specifier.startsWith('@')) return null

  const configPath = nearestConfig(root, fromDir)
  if (configPath) {
    const found = viaPaths(root, pathsConfig(root, configPath), specifier)
    if (found) return found
  }

  const parts = splitPackage(specifier)
  if (!parts) return null
  const workspace = workspacePackages(root).get(parts.name)
  if (workspace) {
    const found = inPackage(root, workspace, parts.sub)
    if (found) return found
  }
  /* node_modules inside the root, nearest first: the last resort. */
  let at = fromDir
  for (let i = 0; i < 64 && contains(root, at); i += 1) {
    const dir = dirInside(root, join(at, 'node_modules', parts.name))
    if (dir) {
      const found = inPackage(root, dir, parts.sub)
      if (found) return found
    }
    if (at === root) break
    at = dirname(at)
  }
  return null
}
