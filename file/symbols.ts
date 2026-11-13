import { statSync } from 'node:fs'
import { join } from 'node:path'

import ts from 'typescript'

import { fileInside } from './imports.ts'
import { fuzzy } from './quick.ts'
import { readText } from './search.ts'
import { tongue } from './shape.ts'
import { walk } from './walk.ts'

/**
 * Symbols: the outline of one file (go to symbol in file), and every declaration
 * of a project matched by a fuzzy name (go to symbol in project).
 *
 * JavaScript and TypeScript are read by TypeScript's own parser and navigation
 * tree, one file at a time and with no program behind it, so an outline costs a
 * parse. Markdown gives its headings. Everything else gets declaration shapes by
 * regular expression, which is honest about being a guess.
 */

export type SymbolKind =
  | 'function'
  | 'class'
  | 'method'
  | 'property'
  | 'variable'
  | 'interface'
  | 'type'
  | 'enum'
  | 'module'
  | 'heading'
  | 'key'
  | 'other'

export interface OutlineSymbol {
  name: string
  kind: SymbolKind
  /** 1-based. */
  line: number
  /** 0-based. */
  column: number
  depth: number
  container?: string
}

export interface ProjectSymbol {
  name: string
  kind: SymbolKind
  relative: string
  line: number
  column: number
  container: string | null
  score: number
  /** Indices in `name` of the matched characters. */
  hits: number[]
}

const TS_FILE = /\.(?:[cm]?tsx?|[cm]?jsx?)$/i
const MAX_SYMBOLS = 5000
const OUTLINE_BYTES = 1_048_576
const PROJECT_MS = 2000

/* ------------------------------------------------------------------ *
 * JavaScript and TypeScript
 * ------------------------------------------------------------------ */

/** TypeScript's element kinds (`ts.ScriptElementKind`), as the strings they are. */
const KINDS = new Map<string, SymbolKind>([
  ['function', 'function'],
  ['local function', 'function'],
  ['class', 'class'],
  ['local class', 'class'],
  ['method', 'method'],
  ['constructor', 'method'],
  ['getter', 'property'],
  ['setter', 'property'],
  ['property', 'property'],
  ['accessor', 'property'],
  ['enum member', 'property'],
  ['var', 'variable'],
  ['local var', 'variable'],
  ['const', 'variable'],
  ['let', 'variable'],
  ['using', 'variable'],
  ['await using', 'variable'],
  ['interface', 'interface'],
  ['type', 'type'],
  ['enum', 'enum'],
  ['module', 'module'],
])

function scriptKind(name: string): ts.ScriptKind {
  const lower = name.toLowerCase()
  if (lower.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (lower.endsWith('.jsx')) return ts.ScriptKind.JSX
  if (/\.[cm]?js$/.test(lower)) return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

/**
 * The navigation tree of one text, from a language service that holds that one
 * file and nothing else: the tree is syntactic, so no program and no library is
 * ever built or read.
 */
function navigationTree(name: string, text: string): ts.NavigationTree {
  const fileName = `/__outline__/${name.replace(/[^\w.-]/g, '_')}`
  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => ({ allowJs: true, jsx: ts.JsxEmit.Preserve, noLib: true, noResolve: true }),
    getScriptFileNames: () => [fileName],
    getScriptVersion: () => '1',
    getScriptSnapshot: (path) => (path === fileName ? ts.ScriptSnapshot.fromString(text) : undefined),
    getScriptKind: () => scriptKind(name),
    getCurrentDirectory: () => '/__outline__',
    getDefaultLibFileName: () => '/__outline__/lib.d.ts',
    fileExists: (path) => path === fileName,
    readFile: (path) => (path === fileName ? text : undefined),
  }
  const ls = ts.createLanguageService(host, undefined, ts.LanguageServiceMode.Syntactic)
  try {
    return ls.getNavigationTree(fileName)
  } finally {
    ls.dispose()
  }
}

function tsOutline(name: string, text: string): OutlineSymbol[] {
  const tree = navigationTree(name, text)
  const starts = lineStarts(text)
  const out: OutlineSymbol[] = []
  const visit = (node: ts.NavigationTree, depth: number, container: string | undefined) => {
    for (const child of node.childItems ?? []) {
      if (out.length >= MAX_SYMBOLS) return
      const start = child.nameSpan?.start ?? child.spans[0]?.start ?? 0
      const at = position(starts, start)
      const kind = KINDS.get(child.kind) ?? 'other'
      out.push({ name: child.text, kind, line: at.line, column: at.column, depth, ...(container ? { container } : {}) })
      visit(child, depth + 1, child.text)
    }
  }
  visit(tree, 0, undefined)
  return out
}

/* ------------------------------------------------------------------ *
 * Positions
 * ------------------------------------------------------------------ */

function lineStarts(text: string): number[] {
  const starts = [0]
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) starts.push(i + 1)
  return starts
}

function position(starts: number[], offset: number): { line: number; column: number } {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid]! <= offset) lo = mid
    else hi = mid - 1
  }
  return { line: lo + 1, column: offset - starts[lo]! }
}

/* ------------------------------------------------------------------ *
 * Markdown, JSON, YAML, CSS and declaration shapes
 * ------------------------------------------------------------------ */

function markdownOutline(text: string): OutlineSymbol[] {
  const out: OutlineSymbol[] = []
  const stack: { level: number; name: string }[] = []
  let fence: string | null = null
  text.split('\n').forEach((raw, i) => {
    const line = raw.replace(/\r$/, '')
    const fenced = /^\s{0,3}(```+|~~~+)/.exec(line)
    if (fenced) {
      if (fence === null) fence = fenced[1]![0]!
      else if (fenced[1]![0] === fence) fence = null
      return
    }
    if (fence !== null || out.length >= MAX_SYMBOLS) return
    const m = /^(\s{0,3})(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (!m) return
    const level = m[2]!.length
    while (stack.length && stack.at(-1)!.level >= level) stack.pop()
    const container = stack.at(-1)?.name
    out.push({ name: m[3]!, kind: 'heading', line: i + 1, column: m[1]!.length, depth: stack.length, ...(container ? { container } : {}) })
    stack.push({ level, name: m[3]! })
  })
  return out
}

/** Top-level keys of a JSON object, by a small scanner that knows strings and depth. */
function jsonOutline(text: string): OutlineSymbol[] {
  const out: OutlineSymbol[] = []
  const starts = lineStarts(text)
  let depth = 0
  for (let i = 0; i < text.length && out.length < MAX_SYMBOLS; i += 1) {
    const c = text[i]
    if (c === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      if (depth === 1) {
        let k = j + 1
        while (k < text.length && /\s/.test(text[k]!)) k += 1
        if (text[k] === ':') {
          const at = position(starts, i)
          out.push({ name: text.slice(i + 1, j), kind: 'key', line: at.line, column: at.column, depth: 0 })
        }
      }
      i = j
    } else if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i)
      i = end === -1 ? text.length : end
    } else if (c === '{' || c === '[') depth += 1
    else if (c === '}' || c === ']') depth -= 1
  }
  return out
}

function yamlOutline(text: string): OutlineSymbol[] {
  const out: OutlineSymbol[] = []
  text.split('\n').forEach((line, i) => {
    if (out.length >= MAX_SYMBOLS) return
    const m = /^(["']?)([^\s#'"\-:?][^:#]*?)\1\s*:(?:\s|$)/.exec(line)
    if (m) out.push({ name: m[2]!, kind: 'key', line: i + 1, column: 0, depth: 0 })
  })
  return out
}

function tomlOutline(text: string): OutlineSymbol[] {
  const out: OutlineSymbol[] = []
  text.split('\n').forEach((line, i) => {
    const m = /^\s*\[\[?([^\]]+)\]\]?/.exec(line)
    if (m && out.length < MAX_SYMBOLS) out.push({ name: m[1]!.trim(), kind: 'module', line: i + 1, column: line.indexOf(m[1]!), depth: 0 })
  })
  return out
}

function cssOutline(text: string): OutlineSymbol[] {
  const out: OutlineSymbol[] = []
  let depth = 0
  let comment = false
  text.split('\n').forEach((raw, i) => {
    const line = raw.replace(/\r$/, '')
    if (out.length >= MAX_SYMBOLS) return
    let code = ''
    for (let j = 0; j < line.length; j += 1) {
      if (comment) {
        if (line[j] === '*' && line[j + 1] === '/') {
          comment = false
          j += 1
        }
      } else if (line[j] === '/' && line[j + 1] === '*') {
        comment = true
        j += 1
      } else code += line[j]
    }
    if (depth === 0) {
      const m = /^(\s*)([^\s{}][^{}]*?)\s*\{/.exec(code)
      if (m) out.push({ name: m[2]!, kind: m[2]!.startsWith('@') ? 'module' : 'other', line: i + 1, column: m[1]!.length, depth: 0 })
    }
    for (const c of code) {
      if (c === '{') depth += 1
      else if (c === '}') depth = Math.max(0, depth - 1)
    }
  })
  return out
}

interface Shape {
  regex: RegExp
  kind: SymbolKind
}

const C_LIKE_SKIP = new Set(['if', 'for', 'while', 'switch', 'return', 'catch', 'else', 'do', 'sizeof', 'new', 'delete'])

const SHAPES: Record<string, Shape[]> = {
  python: [
    { regex: /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)/, kind: 'function' },
    { regex: /^(\s*)class\s+([A-Za-z_]\w*)/, kind: 'class' },
    { regex: /^()([A-Z_][A-Z0-9_]*)\s*(?::[^=]*)?=(?!=)/, kind: 'variable' },
  ],
  go: [
    { regex: /^()func\s+\([^)]*\)\s*([A-Za-z_]\w*)/, kind: 'method' },
    { regex: /^()func\s+([A-Za-z_]\w*)/, kind: 'function' },
    { regex: /^()type\s+([A-Za-z_]\w*)\s+struct\b/, kind: 'class' },
    { regex: /^()type\s+([A-Za-z_]\w*)\s+interface\b/, kind: 'interface' },
    { regex: /^()type\s+([A-Za-z_]\w*)/, kind: 'type' },
  ],
  rust: [
    { regex: /^(\s*)(?:pub(?:\([^)]*\))?\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+([A-Za-z_]\w*)/, kind: 'function' },
    { regex: /^(\s*)(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)/, kind: 'class' },
    { regex: /^(\s*)(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)/, kind: 'enum' },
    { regex: /^(\s*)(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_]\w*)/, kind: 'interface' },
    { regex: /^(\s*)(?:pub(?:\([^)]*\))?\s+)?type\s+([A-Za-z_]\w*)/, kind: 'type' },
    { regex: /^(\s*)(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)/, kind: 'module' },
    { regex: /^(\s*)impl(?:<[^>]*>)?\s+(?:[\w:<>, ]+\s+for\s+)?([A-Za-z_]\w*)/, kind: 'class' },
  ],
  swift: [
    { regex: /^(\s*)(?:(?:public|private|internal|open|fileprivate|static|override|final|@\w+)\s+)*func\s+([A-Za-z_]\w*)/, kind: 'function' },
    { regex: /^(\s*)(?:(?:public|private|internal|open|final)\s+)*(?:class|struct|actor|extension)\s+([A-Za-z_]\w*)/, kind: 'class' },
    { regex: /^(\s*)(?:(?:public|private|internal)\s+)*protocol\s+([A-Za-z_]\w*)/, kind: 'interface' },
    { regex: /^(\s*)(?:(?:public|private|internal)\s+)*enum\s+([A-Za-z_]\w*)/, kind: 'enum' },
  ],
  kotlin: [
    { regex: /^(\s*)(?:(?:public|private|internal|open|override|suspend|inline|private|protected)\s+)*fun\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?([A-Za-z_]\w*)/, kind: 'function' },
    { regex: /^(\s*)(?:(?:public|private|internal|open|data|sealed|abstract|enum)\s+)*(?:class|object)\s+([A-Za-z_]\w*)/, kind: 'class' },
    { regex: /^(\s*)(?:(?:public|private|internal|sealed|fun)\s+)*interface\s+([A-Za-z_]\w*)/, kind: 'interface' },
  ],
  java: [
    { regex: /^(\s*)(?:(?:public|private|protected|static|final|abstract|sealed)\s+)*(?:class|record)\s+([A-Za-z_]\w*)/, kind: 'class' },
    { regex: /^(\s*)(?:(?:public|private|protected|static)\s+)*interface\s+([A-Za-z_]\w*)/, kind: 'interface' },
    { regex: /^(\s*)(?:(?:public|private|protected|static)\s+)*enum\s+([A-Za-z_]\w*)/, kind: 'enum' },
    { regex: /^(\s+)(?:(?:public|private|protected|static|final|abstract|synchronized)\s+)+[\w<>[\], ]+\s+([A-Za-z_]\w*)\s*\(/, kind: 'method' },
  ],
  c: [
    { regex: /^()(?:struct|union|enum)\s+([A-Za-z_]\w*)\s*\{/, kind: 'class' },
    { regex: /^()#\s*define\s+([A-Za-z_]\w*)/, kind: 'variable' },
    { regex: /^()[A-Za-z_][\w\s*&:<>,]*?[\s*&]([A-Za-z_]\w*)\s*\([^;]*$/, kind: 'function' },
  ],
  ruby: [
    { regex: /^(\s*)def\s+(?:self\.)?([A-Za-z_]\w*[?!=]?)/, kind: 'method' },
    { regex: /^(\s*)class\s+([A-Z]\w*)/, kind: 'class' },
    { regex: /^(\s*)module\s+([A-Z]\w*)/, kind: 'module' },
  ],
  lua: [{ regex: /^(\s*)(?:local\s+)?function\s+([\w.:]+)/, kind: 'function' }],
  shell: [
    { regex: /^(\s*)(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\)\s*\{?/, kind: 'function' },
    { regex: /^(\s*)function\s+([A-Za-z_][\w-]*)/, kind: 'function' },
  ],
  latex: [{ regex: /^(\s*)\\(?:part|chapter|(?:sub)*section|paragraph)\*?\{([^}]+)\}/, kind: 'heading' }],
}
SHAPES.cpp = SHAPES.c!

/** A guess at declarations by shape, with depth from indentation. */
function shapeOutline(shapes: Shape[], text: string): OutlineSymbol[] {
  const out: OutlineSymbol[] = []
  const stack: { indent: number; name: string; kind: SymbolKind }[] = []
  text.split('\n').forEach((raw, i) => {
    if (out.length >= MAX_SYMBOLS) return
    const line = raw.replace(/\r$/, '')
    for (const shape of shapes) {
      const m = shape.regex.exec(line)
      if (!m) continue
      const name = m[2]!
      if (C_LIKE_SKIP.has(name)) return
      const indent = m[1]!.replace(/\t/g, '    ').length
      while (stack.length && stack.at(-1)!.indent >= indent) stack.pop()
      const parent = stack.at(-1)
      const kind: SymbolKind = shape.kind === 'function' && parent?.kind === 'class' ? 'method' : shape.kind
      out.push({ name, kind, line: i + 1, column: line.indexOf(name, m[1]!.length), depth: stack.length, ...(parent ? { container: parent.name } : {}) })
      stack.push({ indent, name, kind })
      return
    }
  })
  return out
}

/** Declarations in any language, by the shapes every C-ish or scripting language shares. */
const GENERIC: Shape[] = [
  { regex: /^(\s*)(?:export\s+)?(?:async\s+)?(?:function|def|fn|func|fun|sub|proc)\s+([A-Za-z_][\w$]*)/, kind: 'function' },
  { regex: /^(\s*)(?:export\s+)?(?:abstract\s+)?(?:class|struct|trait|protocol|object)\s+([A-Za-z_][\w$]*)/, kind: 'class' },
  { regex: /^(\s*)(?:export\s+)?(?:interface)\s+([A-Za-z_][\w$]*)/, kind: 'interface' },
  { regex: /^(\s*)(?:export\s+)?(?:enum)\s+([A-Za-z_][\w$]*)/, kind: 'enum' },
  { regex: /^(\s*)(?:export\s+)?(?:type)\s+([A-Za-z_][\w$]*)\s*=/, kind: 'type' },
]

/** The outline of a text, by its file name. */
export function outlineText(name: string, text: string): OutlineSymbol[] {
  if (TS_FILE.test(name)) {
    try {
      return tsOutline(name, text)
    } catch {
      return shapeOutline(GENERIC, text)
    }
  }
  const language = tongue(name)
  switch (language) {
    case 'markdown':
      return markdownOutline(text)
    case 'json':
      return jsonOutline(text)
    case 'yaml':
      return yamlOutline(text)
    case 'toml':
      return tomlOutline(text)
    case 'css':
      return cssOutline(text)
    default:
      return shapeOutline((language && SHAPES[language]) || GENERIC, text)
  }
}

/** The outline of a project file. `relative` has been through `locate`; `text` is the page's unsaved text. */
export function outline(root: string, relative: string, text?: string): OutlineSymbol[] {
  const content = text ?? readText(root, relative, OUTLINE_BYTES)
  if (content === null) return []
  return outlineText(relative, content)
}

/* ------------------------------------------------------------------ *
 * Project symbols
 * ------------------------------------------------------------------ */

/** Outlines by real path, kept while the file's size and time are the same. */
const outlines = new Map<string, { stamp: string; symbols: OutlineSymbol[] }>()
const MAX_OUTLINES = 20_000

/** For tests. */
export function forgetOutlines(): void {
  outlines.clear()
}

/** The kinds a project search lists: declarations, not keys of data files or locals. */
const PROJECT_KINDS = new Set<SymbolKind>(['function', 'class', 'method', 'interface', 'type', 'enum', 'module', 'variable', 'property', 'heading'])

function cachedOutline(root: string, relative: string): OutlineSymbol[] {
  const real = fileInside(root, join(root, relative))
  if (!real) return []
  let stamp: string
  try {
    const stat = statSync(real)
    if (stat.size > OUTLINE_BYTES) return []
    stamp = `${stat.size}:${stat.mtimeMs}`
  } catch {
    return []
  }
  const known = outlines.get(real)
  if (known && known.stamp === stamp) return known.symbols
  const symbols = outline(root, relative)
  if (outlines.size >= MAX_OUTLINES) outlines.clear()
  outlines.set(real, { stamp, symbols })
  return symbols
}

/** Which files carry declarations worth listing: code, and Markdown for its headings. */
const SYMBOL_FILES = /\.(?:[cm]?[tj]sx?|py|go|rs|swift|kt|java|c|h|cc|cpp|hpp|rb|lua|sh|bash|zsh|md|markdown|css|scss|less|tex)$/i

/**
 * Every declaration in the project whose name fuzzy-matches `query`, best first.
 * Bounded in time: what was read when the time ran out is what is ranked.
 */
export async function projectSymbols(root: string, query: string, limit = 100): Promise<ProjectSymbol[]> {
  const q = query.trim()
  if (!q) return []
  const deadline = Date.now() + PROJECT_MS
  const found: ProjectSymbol[] = []
  let read = 0
  for (const relative of walk(root).files) {
    if (!SYMBOL_FILES.test(relative)) continue
    if (Date.now() > deadline) break
    if (read > 0 && read % 50 === 0) await new Promise<void>((done) => setImmediate(done))
    read += 1
    for (const symbol of cachedOutline(root, relative)) {
      if (!PROJECT_KINDS.has(symbol.kind) || /[\s()<>]/.test(symbol.name)) continue
      if (symbol.kind === 'variable' && symbol.depth > 0) continue
      const scored = fuzzy(symbol.name, q, 0)
      if (!scored) continue
      found.push({
        name: symbol.name,
        kind: symbol.kind,
        relative,
        line: symbol.line,
        column: symbol.column,
        container: symbol.container ?? null,
        score: scored.score,
        hits: scored.hits,
      })
    }
  }
  found.sort((a, b) => b.score - a.score || a.relative.length - b.relative.length || a.line - b.line)
  return found.slice(0, Math.max(0, limit))
}
