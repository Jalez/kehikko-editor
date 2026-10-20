import { StreamLanguage, type LanguageSupport, type StreamParser } from '@codemirror/language'
import type { Extension } from '@codemirror/state'

/**
 * The grammar for a language name from `tongue` (file/shape.ts), loaded when a
 * file in that language is first opened. Each one is its own chunk, so the page
 * ships the editor and nothing else up front; a TypeScript file costs the
 * JavaScript grammar, and a YAML file never does.
 *
 * Lezer grammars where CodeMirror has a package for them, the legacy stream
 * modes for the rest. An unknown name, or a grammar that fails to load, draws
 * the file plain — never an error in front of the text.
 */
const stream = (parser: StreamParser<unknown>): Extension => StreamLanguage.define(parser)

const LOADERS: Record<string, () => Promise<Extension | LanguageSupport>> = {
  typescript: async () => (await import('@codemirror/lang-javascript')).javascript({ typescript: true }),
  tsx: async () => (await import('@codemirror/lang-javascript')).javascript({ typescript: true, jsx: true }),
  javascript: async () => (await import('@codemirror/lang-javascript')).javascript(),
  jsx: async () => (await import('@codemirror/lang-javascript')).javascript({ jsx: true }),
  json: async () => (await import('@codemirror/lang-json')).json(),
  css: async () => (await import('@codemirror/lang-css')).css(),
  html: async () => (await import('@codemirror/lang-html')).html(),
  markdown: async () => (await import('@codemirror/lang-markdown')).markdown(),
  python: async () => (await import('@codemirror/lang-python')).python(),
  shell: async () => stream((await import('@codemirror/legacy-modes/mode/shell')).shell as StreamParser<unknown>),
  yaml: async () => stream((await import('@codemirror/legacy-modes/mode/yaml')).yaml as StreamParser<unknown>),
  toml: async () => stream((await import('@codemirror/legacy-modes/mode/toml')).toml as StreamParser<unknown>),
  properties: async () => stream((await import('@codemirror/legacy-modes/mode/properties')).properties as StreamParser<unknown>),
  latex: async () => stream((await import('@codemirror/legacy-modes/mode/stex')).stex as StreamParser<unknown>),
  rust: async () => stream((await import('@codemirror/legacy-modes/mode/rust')).rust as StreamParser<unknown>),
  go: async () => stream((await import('@codemirror/legacy-modes/mode/go')).go as StreamParser<unknown>),
  ruby: async () => stream((await import('@codemirror/legacy-modes/mode/ruby')).ruby as StreamParser<unknown>),
  lua: async () => stream((await import('@codemirror/legacy-modes/mode/lua')).lua as StreamParser<unknown>),
  sql: async () => stream((await import('@codemirror/legacy-modes/mode/sql')).standardSQL as StreamParser<unknown>),
  diff: async () => stream((await import('@codemirror/legacy-modes/mode/diff')).diff as StreamParser<unknown>),
  swift: async () => stream((await import('@codemirror/legacy-modes/mode/swift')).swift as StreamParser<unknown>),
  c: async () => stream((await import('@codemirror/legacy-modes/mode/clike')).c as StreamParser<unknown>),
  cpp: async () => stream((await import('@codemirror/legacy-modes/mode/clike')).cpp as StreamParser<unknown>),
  java: async () => stream((await import('@codemirror/legacy-modes/mode/clike')).java as StreamParser<unknown>),
  kotlin: async () => stream((await import('@codemirror/legacy-modes/mode/clike')).kotlin as StreamParser<unknown>),
  dockerfile: async () => stream((await import('@codemirror/legacy-modes/mode/dockerfile')).dockerFile as StreamParser<unknown>),
}

/** Every name this page can load a grammar for. `test/languages.test.ts` holds it against `tongue`. */
export const LOADABLE: readonly string[] = Object.keys(LOADERS)

export async function loadLanguage(name: string | null): Promise<Extension | null> {
  const load = name ? LOADERS[name] : undefined
  if (!load) return null
  try {
    return await load()
  } catch {
    return null
  }
}
