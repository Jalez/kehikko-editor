/**
 * What this app is willing to say about a file, and every bound it puts on
 * opening and saving one.
 *
 * Shapes and numbers only — no filesystem, no React — because the server and
 * the page both work in these.
 */

/** A path in a request. The protocol's own `LIMITS.PATH`. */
export const MAX_PATH = 4096

/**
 * The largest file this app opens for editing, and the largest it will save.
 *
 * One megabyte. Source shows a quarter of that and moves its window; an editor
 * cannot show a window, because saving a window would cut the rest of the file
 * off. So a file is opened whole or not at all, and the bound is where whole
 * stops being something a container on a canvas can hold, ship as JSON and keep
 * a draft of in the tab's storage. CodeMirror draws only what is on screen, so
 * the drawing is not what sets it. A larger file is refused with a sentence.
 */
export const MAX_BYTES = 1_048_576

/** How many bytes are sniffed to decide whether a file is text. git's number. */
export const SNIFF_BYTES = 8192

/**
 * What a file's version is: what the edit started from, and what a save has to
 * still find on disk. Size and modification time catch nearly every change for
 * free; the content hash catches the rest — a tool that rewrites a file within
 * the same millisecond with the same length, or one that restores mtime.
 */
export interface Version {
  size: number
  mtimeMs: number
  /** sha256 of the bytes, hex. */
  hash: string
}

/** One string for a version, compared whole. */
export function versionToken(version: Version): string {
  return `${version.size}:${Math.round(version.mtimeMs)}:${version.hash}`
}

/** A version token, or null for anything that is not one. */
export function parseToken(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 128) return null
  return /^\d+:\d+:[0-9a-f]{64}$/.test(value) ? value : null
}

/** One file, opened for editing. */
export interface Opened {
  kind: 'text'
  /** Absolute, as this app resolved it (the real path). */
  path: string
  /** Relative to the project root, with forward slashes. The key a draft is kept under. */
  relative: string
  text: string
  /** The version `text` was read at, as a token. A save sends it back as its base. */
  version: string
  /** The line ending the file uses, so the editor keeps it. */
  eol: '\n' | '\r\n'
  language: string | null
  /**
   * Why this file is open read-only here, in a sentence naming the owner or the
   * reason; null when it can be saved.
   */
  readOnly: string | null
  /** Shown to the person but refused to agents (an `.env`, say). */
  hidden: boolean
}

/** A file this app will not open for editing, with the sentence why. */
export interface Refused {
  kind: 'refused'
  error: string
}

export type Reading = Opened | Refused

/** A string argument, bounded, or `''`. */
export function str(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return trimmed.length > max ? '' : trimmed
}

/** A size in bytes, for a person. */
export function bytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`
}

/**
 * Whether a chunk of a file is not text: a NUL byte (git's rule), or more than a
 * tenth control characters that no text file uses. Source's rule, unchanged.
 */
export function binary(chunk: Uint8Array): boolean {
  if (chunk.length === 0) return false
  let odd = 0
  for (let i = 0; i < chunk.length; i += 1) {
    const byte = chunk[i]!
    if (byte === 0) return true
    if (byte < 9 || (byte > 13 && byte < 32 && byte !== 27) || byte === 127) odd += 1
  }
  return odd / chunk.length > 0.1
}

/**
 * Which language to highlight a file as, from its name alone (the page loads the
 * grammar for it). Null draws it plain, which is the right failure.
 */
export function tongue(path: string): string | null {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  const whole = BY_NAME[name]
  if (whole) return whole
  if (name.startsWith('.env')) return 'properties'
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return null
  return BY_EXTENSION[name.slice(dot + 1)] ?? null
}

const BY_NAME: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'shell',
  '.gitignore': 'shell',
  '.bashrc': 'shell',
  '.zshrc': 'shell',
}

const BY_EXTENSION: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  json: 'json',
  jsonc: 'json',
  css: 'css',
  scss: 'css',
  less: 'css',
  html: 'html',
  htm: 'html',
  svg: 'html',
  xml: 'html',
  md: 'markdown',
  markdown: 'markdown',
  py: 'python',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  fish: 'shell',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  ini: 'properties',
  cfg: 'properties',
  conf: 'properties',
  properties: 'properties',
  tex: 'latex',
  sty: 'latex',
  cls: 'latex',
  bib: 'latex',
  rs: 'rust',
  go: 'go',
  rb: 'ruby',
  lua: 'lua',
  sql: 'sql',
  diff: 'diff',
  patch: 'diff',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  hpp: 'cpp',
  java: 'java',
  kt: 'kotlin',
}

/** Every language name `tongue` can answer, so the page's loader can be checked against it. */
export const LANGUAGES: readonly string[] = [...new Set([...Object.values(BY_NAME), ...Object.values(BY_EXTENSION), 'properties'])]
