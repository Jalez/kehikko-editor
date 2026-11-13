import { COMMAND_IDS } from './list.ts'

/**
 * Keyboard shortcuts, in VS Code's own shape: a list of `{ "key", "command", "when" }`.
 *
 *  - `key` is VS Code's key syntax: modifiers `ctrl`, `shift`, `alt` (`option`), `cmd` (`meta`,
 *    `win`) joined to a key with `+`; a chord is two presses with a space between (`cmd+k cmd+w`).
 *    `click` as the key is a press of the mouse in the text (`cmd+click`).
 *  - `command` is a command id (`list.ts`); `-<id>` takes a default away (with `key`, only that one).
 *  - `when` is a small expression over the context keys below: names, `!`, `&&`, `||`, parentheses.
 *
 * The defaults ship with the module (`keybindings.default.json`, with a `mac` key where macOS
 * differs, as VS Code's defaults do). The person's own list is laid over them: later wins, and a
 * removal takes a default away. A bad entry is skipped and said in words with its line; the rest
 * still work. The text is JSON with comments and trailing commas (as VS Code's keybindings.json).
 *
 * Pure: no DOM beyond reading the fields of a key event it is handed.
 */

/** The context keys a `when` may name, and what each means. */
export const WHEN_KEYS: Record<string, string> = {
  editorTextFocus: 'The keyboard is in the file’s text.',
  editorFocus: 'The keyboard is anywhere in the Editor except a text field of its own (the find box, a picker).',
  inputFocus: 'The keyboard is in a text field other than the file’s text.',
  tabFocus: 'The keyboard is on a tab in the strip.',
  hasTabs: 'At least one tab is open.',
  hasUnsaved: 'The active tab has unsaved changes.',
  pickerOpen: 'A picker is open (the palette, Go to file, a symbol list).',
  searchViewFocus: 'The keyboard is in Search in project.',
  searchViewVisible: 'Search in project is showing.',
  findWidgetVisible: 'The find box over the text is open.',
  readOnly: 'The active tab is read-only.',
  isMac: 'This is a Mac.',
}

/**
 * Chords the app keeps for itself, which a binding may not take: the app hears them on its own page
 * and a module that swallowed them would break them inside its frame. Alt+Shift+N goes to the next
 * thing that needs the person; Alt+Shift+P pins the place on screen.
 */
export const RESERVED: readonly string[] = ['shift+alt+n', 'shift+alt+p']

const MODIFIERS = ['ctrl', 'shift', 'alt', 'cmd'] as const
type Modifier = (typeof MODIFIERS)[number]

const MODIFIER_NAMES: Record<string, Modifier> = {
  ctrl: 'ctrl', control: 'ctrl', shift: 'shift', alt: 'alt', option: 'alt', opt: 'alt', cmd: 'cmd', meta: 'cmd', win: 'cmd', command: 'cmd', super: 'cmd',
}

const NAMED = new Set([
  'escape', 'enter', 'tab', 'space', 'backspace', 'delete', 'insert', 'home', 'end', 'pageup', 'pagedown',
  'up', 'down', 'left', 'right', 'click', 'numpad_add', 'numpad_subtract',
  ...Array.from({ length: 19 }, (_, i) => `f${i + 1}`),
])
const KEY_ALIASES: Record<string, string> = {
  esc: 'escape', return: 'enter', del: 'delete', ins: 'insert', uparrow: 'up', downarrow: 'down', leftarrow: 'left', rightarrow: 'right',
  pgup: 'pageup', pgdn: 'pagedown', 'page_up': 'pageup', 'page_down': 'pagedown',
}
const PUNCTUATION = new Set([';', '=', ',', '-', '.', '/', '`', '[', '\\', ']', "'"])

/** One press, normalised: modifiers in a fixed order, then the key (`ctrl+shift+p`). Null when it is not one. */
export function parsePress(text: string): string | null {
  const pieces = text.trim().toLowerCase().split('+')
  /* `ctrl++` is ctrl and the plus key: VS Code spells it `ctrl+=` with shift, so a lone `+` is not a key here. */
  if (pieces.some((piece) => piece === '')) return null
  const mods = new Set<Modifier>()
  let key: string | null = null
  for (const [index, raw] of pieces.entries()) {
    const piece = raw.trim()
    const modifier = MODIFIER_NAMES[piece]
    if (modifier && index < pieces.length - 1) {
      if (mods.has(modifier)) return null
      mods.add(modifier)
      continue
    }
    if (index !== pieces.length - 1) return null
    const named = KEY_ALIASES[piece] ?? piece
    if (NAMED.has(named) || /^[a-z0-9]$/.test(named) || PUNCTUATION.has(named)) key = named
    else return null
  }
  if (!key) return null
  return [...MODIFIERS.filter((one) => mods.has(one)), key].join('+')
}

/** A whole key: one press, or a chord of two. Null when it is not one. */
export function parseKey(text: string): string[] | null {
  if (typeof text !== 'string' || text.length > 100) return null
  const parts = text.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0 || parts.length > 2) return null
  const out: string[] = []
  for (const part of parts) {
    const press = parsePress(part)
    if (!press) return null
    out.push(press)
  }
  /* A mouse press ends a key; it cannot start a chord. */
  if (out.length === 2 && out[0]!.endsWith('click')) return null
  return out
}

/* ---- `when` ----------------------------------------------------------- */

export type When = { kind: 'key'; name: string } | { kind: 'not'; of: When } | { kind: 'and' | 'or'; left: When; right: When }

/** Parse a `when`. Throws an Error with a sentence when it is not one. */
export function parseWhen(text: string): When {
  const tokens = text.match(/\s*(\(|\)|!|&&|\|\||[A-Za-z_][A-Za-z0-9_.]*|\S)/g)?.map((one) => one.trim()) ?? []
  let at = 0
  const peek = () => tokens[at]
  const next = () => tokens[at++]
  const primary = (): When => {
    const token = next()
    if (token === '!') return { kind: 'not', of: primary() }
    if (token === '(') {
      const inner = or()
      if (next() !== ')') throw new Error('a "(" is not closed')
      return inner
    }
    if (token && /^[A-Za-z_][A-Za-z0-9_.]*$/.test(token)) {
      if (!Object.prototype.hasOwnProperty.call(WHEN_KEYS, token)) throw new Error(`"${token}" is not a context this editor knows (${Object.keys(WHEN_KEYS).join(', ')})`)
      return { kind: 'key', name: token }
    }
    throw new Error(token ? `"${token}" was not expected` : 'it ends too early')
  }
  const and = (): When => {
    let left = primary()
    while (peek() === '&&') {
      next()
      left = { kind: 'and', left, right: primary() }
    }
    return left
  }
  const or = (): When => {
    let left = and()
    while (peek() === '||') {
      next()
      left = { kind: 'or', left, right: and() }
    }
    return left
  }
  if (!tokens.length) throw new Error('it is empty')
  const tree = or()
  if (at < tokens.length) throw new Error(`"${tokens[at]}" was not expected`)
  return tree
}

export type WhenContext = Partial<Record<keyof typeof WHEN_KEYS | string, boolean>>

export function holds(when: When | null, context: WhenContext): boolean {
  if (!when) return true
  switch (when.kind) {
    case 'key':
      return context[when.name] === true
    case 'not':
      return !holds(when.of, context)
    case 'and':
      return holds(when.left, context) && holds(when.right, context)
    case 'or':
      return holds(when.left, context) || holds(when.right, context)
  }
}

/* ---- JSON with comments, with positions ------------------------------- */

export interface Problem {
  line: number
  said: string
}

/** A value with where it starts in the text, for saying a line. */
interface Located {
  value: unknown
  at: number
}

/** Parse JSON with comments and trailing commas. Throws `{ at, said }` with the offset of the fault. */
function parseJsonc(text: string): { value: unknown; items: Located[] | null } {
  let i = 0
  const fail = (said: string): never => {
    throw { at: i, said }
  }
  const space = () => {
    for (;;) {
      const c = text[i]
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '﻿') i += 1
      else if (c === '/' && text[i + 1] === '/') {
        while (i < text.length && text[i] !== '\n') i += 1
      } else if (c === '/' && text[i + 1] === '*') {
        const end = text.indexOf('*/', i + 2)
        if (end < 0) fail('a comment is not closed')
        i = end + 2
      } else return
    }
  }
  const string = (): string => {
    const start = i
    i += 1
    let out = ''
    while (i < text.length && text[i] !== '"') {
      if (text[i] === '\n') {
        i = start
        fail('a string is not closed on its line')
      }
      if (text[i] === '\\') {
        const e = text[i + 1]
        const simple: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }
        if (e && simple[e] !== undefined) {
          out += simple[e]
          i += 2
        } else if (e === 'u' && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) {
          out += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16))
          i += 6
        } else fail('a string has a backslash that is not an escape')
      } else out += text[i++]
    }
    if (text[i] !== '"') {
      i = start
      fail('a string is not closed')
    }
    i += 1
    return out
  }
  const value = (): unknown => {
    space()
    const c = text[i]
    if (c === '{') {
      i += 1
      const out: Record<string, unknown> = {}
      space()
      while (text[i] !== '}') {
        if (text[i] !== '"') fail('a name in quotes was expected')
        const name = string()
        space()
        if (text[i] !== ':') fail('a ":" was expected')
        i += 1
        out[name] = value()
        space()
        if (text[i] === ',') {
          i += 1
          space()
        } else if (text[i] !== '}') fail('a "," or "}" was expected')
      }
      i += 1
      return out
    }
    if (c === '[') {
      i += 1
      const out: unknown[] = []
      space()
      while (text[i] !== ']') {
        out.push(value())
        space()
        if (text[i] === ',') {
          i += 1
          space()
        } else if (text[i] !== ']') fail('a "," or "]" was expected')
      }
      i += 1
      return out
    }
    if (c === '"') return string()
    const word = /^(true|false|null|-?\d+(\.\d+)?([eE][+-]?\d+)?)/.exec(text.slice(i))
    if (word) {
      i += word[0].length
      return JSON.parse(word[0])
    }
    return fail(i >= text.length ? 'the text ends too early' : `"${text[i]}" was not expected`)
  }
  space()
  /* The top-level array's items, with where each starts, so a bad entry can name its line. */
  let items: Located[] | null = null
  let top: unknown
  if (text[i] === '[') {
    items = []
    i += 1
    space()
    while (text[i] !== ']') {
      if (i >= text.length) fail('the list is not closed with "]"')
      const at = i
      items.push({ value: value(), at })
      space()
      if (text[i] === ',') {
        i += 1
        space()
      } else if (text[i] !== ']') fail('a "," or "]" was expected')
    }
    i += 1
    top = items.map((one) => one.value)
  } else top = value()
  space()
  if (i < text.length) fail('there is more after the end')
  return { value: top, items }
}

const lineOf = (text: string, at: number) => text.slice(0, Math.max(0, at)).split('\n').length

/* ---- Bindings ---------------------------------------------------------- */

export interface Binding {
  parts: string[]
  command: string
  when: When | null
  whenText: string | null
  source: 'default' | 'user'
}

/** One entry as written: `key` (and the defaults' `mac`), `command`, `when`. */
export interface Entry {
  key?: unknown
  mac?: unknown
  command?: unknown
  when?: unknown
}

export interface Read {
  bindings: Binding[]
  /** Removals: a command, and the key it is taken from (null: every key). */
  removals: { command: string; parts: string[] | null }[]
  problems: Problem[]
}

/** Read a list of entries (the defaults, or the person's, already parsed). `lines` names each one's line. */
export function readEntries(entries: readonly unknown[], source: 'default' | 'user', mac: boolean, lines: readonly number[] = []): Read {
  const bindings: Binding[] = []
  const removals: Read['removals'] = []
  const problems: Problem[] = []
  entries.forEach((raw, index) => {
    const line = lines[index] ?? 0
    const say = (said: string) => problems.push({ line, said })
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return say('An entry is an object: { "key": "…", "command": "…" }.')
    const entry = raw as Entry
    const keyText = mac && typeof entry.mac === 'string' ? entry.mac : entry.key
    if (typeof entry.command !== 'string' || !entry.command) return say('"command" is missing: it names what the key does.')
    const removing = entry.command.startsWith('-')
    const command = removing ? entry.command.slice(1) : entry.command
    if (!COMMAND_IDS.has(command)) return say(`"${command}" is not a command here. The keyboard shortcuts list names every one.`)
    let parts: string[] | null = null
    if (keyText !== undefined) {
      if (typeof keyText !== 'string') return say('"key" is text, like "ctrl+shift+p".')
      parts = parseKey(keyText)
      if (!parts) return say(`"${keyText}" is not a key. Write it like "ctrl+shift+p", "f12" or "cmd+k cmd+w".`)
    } else if (!removing) return say('"key" is missing: it says which key runs the command.')
    if (removing) {
      removals.push({ command, parts })
      return
    }
    const reserved = parts!.find((part) => RESERVED.includes(part))
    if (reserved) return say(`${reserved} is the app’s own shortcut and cannot be taken here.`)
    let when: When | null = null
    let whenText: string | null = null
    if (entry.when !== undefined) {
      if (typeof entry.when !== 'string') return say('"when" is text, like "editorTextFocus && !hasUnsaved".')
      try {
        when = parseWhen(entry.when)
        whenText = entry.when.trim()
      } catch (error) {
        return say(`"when" cannot be read: ${(error as Error).message}.`)
      }
    }
    bindings.push({ parts: parts!, command, when, whenText, source })
  })
  return { bindings, removals, problems }
}

export interface Keymap {
  /** In order of precedence, lowest first: the defaults left after removals, then the person's. */
  bindings: Binding[]
  problems: Problem[]
}

/** The person's text read: entries and the problems, each with its line. Empty text is no entries. */
export function readUserText(text: string, mac: boolean): Read {
  if (!text.trim()) return { bindings: [], removals: [], problems: [] }
  try {
    const parsed = parseJsonc(text)
    if (!Array.isArray(parsed.value)) return { bindings: [], removals: [], problems: [{ line: 1, said: 'The shortcuts are a list: [ { "key": "…", "command": "…" } ].' }] }
    return readEntries(parsed.value, 'user', mac, (parsed.items ?? []).map((one) => lineOf(text, one.at)))
  } catch (error) {
    const fault = error as { at?: number; said?: string }
    if (typeof fault.at === 'number') return { bindings: [], removals: [], problems: [{ line: lineOf(text, fault.at), said: `This is not valid JSON: ${fault.said}. Nothing in it is used until it is fixed.` }] }
    throw error
  }
}

/** The defaults with the person's text over them. */
export function keymap(defaults: readonly unknown[], userText: string, mac: boolean): Keymap {
  const base = readEntries(defaults, 'default', mac)
  const user = readUserText(userText, mac)
  const removed = (binding: Binding) =>
    user.removals.some((one) => one.command === binding.command && (one.parts === null || one.parts.join(' ') === binding.parts.join(' ')))
  return { bindings: [...base.bindings.filter((one) => !removed(one)), ...user.bindings], problems: [...base.problems, ...user.problems] }
}

/** Every key a command has now, as written (`cmd+shift+p`). */
export function keysFor(map: Keymap, command: string): string[] {
  return map.bindings.filter((one) => one.command === command).map((one) => one.parts.join(' '))
}

/* ---- Hearing a key ----------------------------------------------------- */

/** What is read of a key event. */
export interface KeyLike {
  key: string
  code?: string
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
}

const CODE_KEYS: Record<string, string> = {
  Semicolon: ';', Equal: '=', Comma: ',', Minus: '-', Period: '.', Slash: '/', Backquote: '`', BracketLeft: '[', Backslash: '\\', BracketRight: ']', Quote: "'",
  Space: 'space', Tab: 'tab', Enter: 'enter', NumpadEnter: 'enter', Escape: 'escape', Backspace: 'backspace', Delete: 'delete', Insert: 'insert',
  Home: 'home', End: 'end', PageUp: 'pageup', PageDown: 'pagedown', ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  NumpadAdd: 'numpad_add', NumpadSubtract: 'numpad_subtract',
}
const KEY_NAMES: Record<string, string> = {
  ' ': 'space', Tab: 'tab', Enter: 'enter', Escape: 'escape', Esc: 'escape', Backspace: 'backspace', Delete: 'delete', Insert: 'insert', Home: 'home', End: 'end',
  PageUp: 'pageup', PageDown: 'pagedown', ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
}

/**
 * A key event as a press (`ctrl+shift+p`), or null for a modifier alone. By `code` for letters,
 * digits and punctuation, so Option's dead keys on a Mac and Shift's symbols do not change the key.
 */
export function pressOf(event: KeyLike): string | null {
  if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Fn', 'OS', 'Dead'].includes(event.key) && !event.code?.startsWith('Key')) return null
  let key: string | null = null
  const code = event.code ?? ''
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3).toLowerCase()
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5)
  else if (/^F([1-9]|1[0-9])$/.test(code)) key = code.toLowerCase()
  else if (CODE_KEYS[code]) key = CODE_KEYS[code]!
  else if (KEY_NAMES[event.key]) key = KEY_NAMES[event.key]!
  else if (/^F([1-9]|1[0-9])$/.test(event.key)) key = event.key.toLowerCase()
  else if (event.key.length === 1) key = event.key.toLowerCase()
  if (!key) return null
  const mods: string[] = []
  if (event.ctrlKey) mods.push('ctrl')
  if (event.shiftKey) mods.push('shift')
  if (event.altKey) mods.push('alt')
  if (event.metaKey) mods.push('cmd')
  return [...mods, key].join('+')
}

/** What a press comes to: a command to run, the first half of a chord, or nothing of ours. */
export type Heard = { kind: 'run'; command: string } | { kind: 'chord'; first: string } | { kind: 'none'; afterChord: boolean }

/**
 * Hear one press, given the first half of a chord pressed before it (or null). The last binding
 * that matches wins, as in VS Code; a chord's first half, when some binding starts with it, waits
 * for the second.
 */
export function hear(map: Keymap, press: string, pending: string | null, context: WhenContext): Heard {
  const sequence = pending ? [pending, press] : [press]
  const live = map.bindings.filter((one) => holds(one.when, context))
  const starts = live.filter((one) => sequence.every((part, i) => one.parts[i] === part))
  if (!pending && starts.some((one) => one.parts.length > 1)) return { kind: 'chord', first: press }
  const full = starts.filter((one) => one.parts.length === sequence.length)
  const chosen = full[full.length - 1]
  if (chosen) return { kind: 'run', command: chosen.command }
  return { kind: 'none', afterChord: pending !== null }
}

/* ---- Saying a key ------------------------------------------------------ */

const MAC_SIGNS: Record<string, string> = { ctrl: '⌃', shift: '⇧', alt: '⌥', cmd: '⌘' }
const KEY_SIGNS: Record<string, string> = {
  enter: '↩', escape: 'Esc', tab: '⇥', space: 'Space', backspace: '⌫', delete: '⌦', up: '↑', down: '↓', left: '←', right: '→',
  pageup: 'PgUp', pagedown: 'PgDn', home: 'Home', end: 'End', click: 'Click',
}

/** A key as a person reads it: `⇧⌘P` on a Mac, `Ctrl+Shift+P` elsewhere, chords with a space. */
export function sayKey(parts: readonly string[], mac: boolean): string {
  return parts
    .map((press) => {
      const pieces = press.split('+')
      const key = pieces.pop()!
      const shown = KEY_SIGNS[key] ?? (key.length === 1 ? key.toUpperCase() : key.toUpperCase())
      if (mac) {
        /* Apple's order: ⌃⌥⇧⌘. */
        const order = ['ctrl', 'alt', 'shift', 'cmd']
        return `${order.filter((one) => pieces.includes(one)).map((one) => MAC_SIGNS[one]).join('')}${shown}`
      }
      const names: Record<string, string> = { ctrl: 'Ctrl', shift: 'Shift', alt: 'Alt', cmd: 'Win' }
      return [...pieces.map((one) => names[one] ?? one), shown].join('+')
    })
    .join(' ')
}
