import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

import ts from 'typescript'

import { contains, inside } from './confine.ts'
import { fileInside, nearestConfig, resolveImport, specifierAt } from './imports.ts'
import { escapeRegex, readText } from './search.ts'
import { walk } from './walk.ts'
import { withheldFrom } from './withheld.ts'

/**
 * Go to definition: an import specifier opens the file it names; in JavaScript
 * and TypeScript the TypeScript language service, in this process, answers; for
 * everything else (and when it says nothing) a bounded text search for the word
 * in declaration shapes.
 *
 * The language service never reads outside the root: its host refuses every path
 * the fence refuses, except TypeScript's own default library files from this
 * module's `typescript` package. It never spawns tsserver and never touches the
 * network. One service per project config, at most three, dropped after ten idle
 * minutes; a root where one call took longer than four seconds is marked slow and
 * gets the text search from then on.
 */

export interface Target {
  relative: string
  /** 1-based. */
  line: number
  /** 0-based. */
  column: number
  preview: string
  kind: 'file' | 'symbol'
}

export interface Definition {
  targets: Target[]
  via: 'import' | 'typescript' | 'text' | null
  said: string | null
}

const TS_FILE = /\.(?:[cm]?tsx?|[cm]?jsx?)$/i
const MAX_SOURCES = 3000
const MAX_SOURCE_BYTES = 20 * 1024 * 1024
const IDLE_MS = 10 * 60 * 1000
const MAX_SERVICES = 3
const SLOW_MS = 4000
const MAX_TARGETS = 50
const TEXT_MS = 2000
const TEXT_FILE_BYTES = 1_048_576
const PREVIEW = 240


/* ------------------------------------------------------------------ *
 * The language service
 * ------------------------------------------------------------------ */

const LIB_DIR = dirname(ts.getDefaultLibFilePath({}))

interface Service {
  key: string
  root: string
  ls: ts.LanguageService
  names: string[]
  /** The page's unsaved text for one file, for one call. */
  override: { file: string; text: string; version: string } | null
  last: number
  /** When `names` was read. */
  listed: number
}

const services = new Map<string, Service>()
const slowRoots = new Set<string>()

/** For tests: drop every service and forget which roots were slow. */
export function forgetServices(): void {
  for (const one of services.values()) one.ls.dispose()
  services.clear()
  slowRoots.clear()
}

/** For tests: mark a root slow, as a call over the time bound would. */
export function markSlow(root: string): void {
  slowRoots.add(root)
}

function isLib(path: string): boolean {
  return contains(LIB_DIR, resolve(path))
}

/** A path the service may look at: inside the root (through the fence) and not withheld, or a default lib file. */
function allowed(root: string, path: string): string | null {
  if (isLib(path)) return resolve(path)
  const real = inside(root, resolve(path))
  if (real === null) return null
  const rel = relative(root, real)
  if (rel && withheldFrom(rel, 'page')) return null
  return real
}

function evict(now: number): void {
  for (const [key, one] of services) {
    if (now - one.last > IDLE_MS) {
      one.ls.dispose()
      services.delete(key)
    }
  }
  while (services.size >= MAX_SERVICES) {
    let oldest: Service | null = null
    for (const one of services.values()) if (!oldest || one.last < oldest.last) oldest = one
    if (!oldest) break
    oldest.ls.dispose()
    services.delete(oldest.key)
  }
}

const DEFAULT_OPTIONS: ts.CompilerOptions = {
  allowJs: true,
  checkJs: false,
  jsx: ts.JsxEmit.Preserve,
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowImportingTsExtensions: true,
  resolveJsonModule: true,
  esModuleInterop: true,
  noEmit: true,
  skipLibCheck: true,
}

function fencedParseHost(root: string): ts.ParseConfigFileHost {
  return {
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    getCurrentDirectory: () => root,
    fileExists: (path) => fileInside(root, path) !== null,
    readFile: (path) => readAllowed(root, path),
    readDirectory: (path, extensions, excludes, includes, depth) => {
      const real = inside(root, path)
      if (real === null) return []
      return ts.sys
        .readDirectory(real, extensions, [...(excludes ?? []), '**/node_modules'], includes, depth)
        .filter((one) => allowed(root, one) !== null)
    },
    onUnRecoverableConfigFileDiagnostic: () => {},
  }
}

function readAllowed(root: string, path: string): string | undefined {
  const real = allowed(root, path)
  if (real === null) return undefined
  try {
    const stat = statSync(real)
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) return undefined
    return readFileSync(real, 'utf8')
  } catch {
    return undefined
  }
}

/** Which files a service starts from, and with which options: the nearest config's list, or the walk's JS/TS files. */
function projectOf(root: string, file: string, configPath: string | null): { names: string[]; options: ts.CompilerOptions } {
  const host = fencedParseHost(root)
  const parse = (path: string) => {
    try {
      return ts.getParsedCommandLineOfConfigFile(path, { noEmit: true }, host) ?? null
    } catch {
      return null
    }
  }
  if (configPath) {
    const parsed = parse(configPath)
    if (parsed) {
      let chosen = parsed
      /* A solution-style config lists references and no files: take the referenced one that holds this file. */
      if (!parsed.fileNames.includes(file) && parsed.projectReferences?.length) {
        for (const reference of parsed.projectReferences.slice(0, 8)) {
          const path = reference.path.endsWith('.json') ? reference.path : join(reference.path, 'tsconfig.json')
          const real = fileInside(root, path)
          const referenced = real ? parse(real) : null
          if (referenced?.fileNames.includes(file)) {
            chosen = referenced
            break
          }
        }
      }
      if (chosen.fileNames.length) {
        const options = { ...DEFAULT_OPTIONS, ...chosen.options, noEmit: true }
        return { names: capped(root, chosen.fileNames), options }
      }
    }
  }
  const names = walk(root).files.filter((one) => TS_FILE.test(one)).map((one) => join(root, one))
  return { names: capped(root, names), options: DEFAULT_OPTIONS }
}

function capped(root: string, names: string[]): string[] {
  const out: string[] = []
  let total = 0
  for (const name of names) {
    if (out.length >= MAX_SOURCES) break
    const real = allowed(root, name)
    if (!real || real.split(sep).includes('node_modules')) continue
    try {
      total += statSync(real).size
    } catch {
      continue
    }
    if (total > MAX_SOURCE_BYTES) break
    out.push(real)
  }
  return out
}

/** How long a service's list of files is trusted before it is read again. */
const LIST_MS = 30_000

function serviceFor(root: string, file: string): Service {
  const now = Date.now()
  const configPath = nearestConfig(root, dirname(file))
  const key = `${root}\0${configPath ?? ''}`
  const existing = services.get(key)
  if (existing) {
    existing.last = now
    if (now - existing.listed > LIST_MS) {
      existing.names = projectOf(root, file, configPath).names
      existing.listed = now
    }
    if (!existing.names.includes(file)) existing.names.push(file)
    return existing
  }
  evict(now)
  const project = projectOf(root, file, configPath)
  const names = project.names.includes(file) ? project.names : [...project.names, file]
  const service: Service = { key, root, ls: null as unknown as ts.LanguageService, names, override: null, last: now, listed: now }
  const versionOf = (path: string): string => {
    if (service.override && service.override.file === path) return service.override.version
    try {
      const stat = statSync(path)
      return `d:${stat.mtimeMs}:${stat.size}`
    } catch {
      return 'gone'
    }
  }
  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => project.options,
    getScriptFileNames: () => service.names,
    getScriptVersion: versionOf,
    getScriptSnapshot: (path) => {
      if (service.override && service.override.file === path) return ts.ScriptSnapshot.fromString(service.override.text)
      const text = readAllowed(root, path)
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text)
    },
    getCurrentDirectory: () => root,
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    fileExists: (path) => {
      const real = allowed(root, path)
      if (real === null) return false
      try {
        return statSync(real).isFile()
      } catch {
        return false
      }
    },
    readFile: (path) => readAllowed(root, path),
    directoryExists: (path) => {
      const real = allowed(root, path)
      if (real === null) return false
      try {
        return statSync(real).isDirectory()
      } catch {
        return false
      }
    },
    getDirectories: (path) => {
      const real = allowed(root, path)
      if (real === null) return []
      try {
        return readdirSync(real, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
      } catch {
        return []
      }
    },
    realpath: (path) => allowed(root, path) ?? path,
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
  }
  service.ls = ts.createLanguageService(host, ts.createDocumentRegistry())
  services.set(key, service)
  return service
}

function textHash(text: string): string {
  let h = 2166136261
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return `${text.length}:${(h >>> 0).toString(16)}`
}

function viaTypeScript(root: string, file: string, offset: number, text: string | undefined): Target[] {
  const service = serviceFor(root, file)
  service.override = text === undefined ? null : { file, text, version: `o:${textHash(text)}` }
  const ls = service.ls
  let found = ls.getDefinitionAtPosition(file, offset) ?? []
  if (!found.length) found = ls.getTypeDefinitionAtPosition(file, offset) ?? []
  /* An alias (an import binding) is followed once more to the real declaration. */
  if (found.length && found.every((one) => one.kind === ts.ScriptElementKind.alias)) {
    const further = found.flatMap((one) => ls.getDefinitionAtPosition(one.fileName, one.textSpan.start) ?? [])
    if (further.length) found = further
  }
  const program = ls.getProgram()
  const targets: Target[] = []
  const seen = new Set<string>()
  for (const one of found) {
    if (isLib(one.fileName)) continue
    const real = allowed(root, one.fileName)
    if (real === null || !contains(root, real) || real === root) continue
    const rel = relative(root, real).split('\\').join('/')
    if (withheldFrom(rel, 'page')) continue
    const source = program?.getSourceFile(one.fileName)
    if (!source) continue
    const at = source.getLineAndCharacterOfPosition(one.textSpan.start)
    const key = `${rel}:${at.line}:${at.character}`
    if (seen.has(key)) continue
    seen.add(key)
    const lines = source.getLineStarts()
    const lineText = source.text.slice(lines[at.line], lines[at.line + 1] ?? source.text.length).replace(/\r?\n$/, '')
    targets.push({ relative: rel, line: at.line + 1, column: at.character, preview: preview(lineText), kind: 'symbol' })
    if (targets.length >= MAX_TARGETS) break
  }
  return targets
}

/* ------------------------------------------------------------------ *
 * The text fallback
 * ------------------------------------------------------------------ */

const WORD = /[\p{L}\p{N}_$]/u

/** The identifier at an offset, or null. */
export function wordAt(text: string, offset: number): string | null {
  let start = Math.max(0, Math.min(offset, text.length))
  let end = start
  while (start > 0 && WORD.test(text[start - 1]!)) start -= 1
  while (end < text.length && WORD.test(text[end]!)) end += 1
  const word = text.slice(start, end)
  if (!word || /^\d/.test(word) || word.length > 200) return null
  return word
}

function wholeWord(name: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}_$])${escapeRegex(name)}(?![\\p{L}\\p{N}_$])`, 'u')
}

/** Declaration shapes across the common languages, for one name. */
export function declarationPattern(name: string): RegExp {
  const n = escapeRegex(name)
  const shapes = [
    `^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s*\\*?\\s*${n}\\b`,
    `^\\s*(?:export\\s+)?(?:default\\s+)?(?:abstract\\s+)?(?:public\\s+|private\\s+|internal\\s+|open\\s+|final\\s+|data\\s+|sealed\\s+)*(?:class|struct|trait|protocol|object|record)\\s+${n}\\b`,
    `^\\s*(?:async\\s+)?def\\s+${n}\\b`,
    `^\\s*(?:pub(?:\\([^)]*\\))?\\s+)?(?:const\\s+)?(?:async\\s+)?(?:unsafe\\s+)?(?:extern\\s+"[^"]*"\\s+)?fn\\s+${n}\\b`,
    `^\\s*func\\s+(?:\\([^)]*\\)\\s*)?${n}\\b`,
    `^\\s*(?:(?:public|private|internal|open|override|static|final)\\s+)*fun\\s+(?:<[^>]*>\\s*)?(?:[\\w.]+\\.)?${n}\\b`,
    `^\\s*(?:export\\s+)?(?:declare\\s+)?(?:const|let|var)\\s+${n}\\b`,
    `^${n}[ \\t]*(?::[^=\\n]*)?=(?!=)`,
    `^\\s*(?:export\\s+)?(?:declare\\s+)?(?:type|interface|enum|namespace|module)\\s+${n}\\b`,
    `^\\s*(?:pub(?:\\([^)]*\\))?\\s+)?(?:enum|type|mod|struct|trait|union)\\s+${n}\\b`,
    `^\\s*#\\s*define\\s+${n}\\b`,
    `^\\s*(?:typedef\\s+[^;]*\\b)${n}\\s*;`,
    `^${n}:(?:\\s|$)`,
  ]
  return new RegExp(shapes.map((one) => `(?:${one})`).join('|'), 'm')
}

async function viaText(root: string, rel: string, name: string): Promise<Target[]> {
  const pattern = new RegExp(declarationPattern(name).source, 'gm')
  const deadline = Date.now() + TEXT_MS
  const files = walk(root).files
  /* The file asked about first, then the rest. */
  const order = files.includes(rel) ? [rel, ...files.filter((one) => one !== rel)] : files
  const targets: Target[] = []
  let read = 0
  for (const one of order) {
    if (Date.now() > deadline || targets.length >= MAX_TARGETS) break
    if (read > 0 && read % 50 === 0) await new Promise<void>((done) => setImmediate(done))
    read += 1
    const text = readText(root, one, TEXT_FILE_BYTES)
    if (text === null || !text.includes(name)) continue
    pattern.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = pattern.exec(text)) !== null) {
      if (m[0].length === 0) {
        pattern.lastIndex += 1
        continue
      }
      const within = wholeWord(name).exec(m[0])
      const nameAt = m.index + (within ? within.index : 0)
      const lineStart = text.lastIndexOf('\n', nameAt - 1) + 1
      let lineEnd = text.indexOf('\n', nameAt)
      if (lineEnd === -1) lineEnd = text.length
      const line = text.slice(0, lineStart).split('\n').length
      targets.push({
        relative: one,
        line,
        column: nameAt - lineStart,
        preview: preview(text.slice(lineStart, lineEnd).replace(/\r$/, '')),
        kind: 'symbol',
      })
      if (targets.length >= MAX_TARGETS) break
    }
  }
  return targets
}

function preview(line: string): string {
  const trimmed = line.trim()
  return trimmed.length > PREVIEW ? `${trimmed.slice(0, PREVIEW - 1)}…` : trimmed
}

/* ------------------------------------------------------------------ *
 * The one entry
 * ------------------------------------------------------------------ */

export const noDefinition = (name: string | null) => (name ? `No definition found for “${name}”.` : 'No definition found.')

/**
 * Where the thing at `offset` in a project file is defined. `relative` has
 * already been through `locate`; `text` is the page's unsaved text for that file.
 */
export async function definition(root: string, rel: string, offset: number, text?: string): Promise<Definition> {
  const real = fileInside(root, join(root, rel))
  const content = text ?? (real ? readText(root, rel, TEXT_FILE_BYTES) : null)
  if (content === null || real === null) return { targets: [], via: null, said: noDefinition(null) }
  const at = Math.max(0, Math.min(offset, content.length))

  const spec = specifierAt(content, at)
  if (spec && at >= spec.from - 1 && at <= spec.to + 1) {
    const found = resolveImport(root, rel, spec.specifier)
    if (found) {
      return { targets: [{ relative: found, line: 1, column: 0, preview: found, kind: 'file' }], via: 'import', said: null }
    }
  }

  if (TS_FILE.test(rel) && !slowRoots.has(root)) {
    const started = Date.now()
    let targets: Target[] = []
    try {
      targets = viaTypeScript(root, real, at, text)
    } catch {
      targets = []
    }
    if (Date.now() - started > SLOW_MS) slowRoots.add(root)
    if (targets.length) return { targets, via: 'typescript', said: null }
  }

  const name = wordAt(content, at)
  if (!name) return { targets: [], via: null, said: noDefinition(null) }
  const targets = await viaText(root, rel, name)
  if (targets.length) return { targets, via: 'text', said: null }
  return { targets: [], via: null, said: noDefinition(name) }
}
