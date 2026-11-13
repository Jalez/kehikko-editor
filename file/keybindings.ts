import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import defaults from '../src/commands/keybindings.default.json'
import { COMMANDS } from '../src/commands/list.ts'
import { keymap, sayKey } from '../src/commands/keys.ts'

/**
 * The person's keyboard shortcuts: their own list over the defaults that ship in
 * `src/commands/keybindings.default.json`, in VS Code's keybindings.json shape.
 *
 * Kept once for this computer (a module setting with `scope: 'machine'`), never in a project: keys
 * are the person's hands, not a project's. The host's Settings shows it as one text setting, and
 * "Open keyboard shortcuts (JSON)" in the Editor edits it with its checks; both go through the same
 * settings door, so this file has one writer.
 */

export { KEYBINDINGS_KEY, MAX_KEYBINDINGS_TEXT, SETTINGS } from '../src/commands/settings.ts'
import { MAX_KEYBINDINGS_TEXT } from '../src/commands/settings.ts'

/** Where this computer's Editor settings are kept. `KEHIKOT_EDITOR_DIR` moves it (the tests). */
export function editorDir(env: Record<string, string | undefined> = process.env, platform: string = process.platform): string {
  if (env.KEHIKOT_EDITOR_DIR) return env.KEHIKOT_EDITOR_DIR
  const home = homedir() // kehikot-storage: allow the person's keyboard shortcuts are machine-wide, kept in the machine's Kehikot directory
  return platform === 'darwin'
    ? join(home, 'Library', 'Application Support', 'Kehikot', 'editor')
    : join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'Kehikot', 'editor')
}

const fileOf = () => join(editorDir(), 'keybindings.json')

/** The person's text, or '' when there is none or it cannot be read. */
export function readKeybindings(): { text: string; problem?: string } {
  try {
    const text = readFileSync(fileOf(), 'utf8')
    return { text: text.length > MAX_KEYBINDINGS_TEXT * 4 ? '' : text }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'ENOENT' ? { text: '' } : { text: '', problem: 'Your keyboard shortcuts could not be read, so the defaults are in use.' }
  }
}

/** Keep the person's text, atomically. A sentence when it cannot be. */
export function writeKeybindings(value: unknown): string | null {
  if (typeof value !== 'string') return 'The keyboard shortcuts are text: a JSON list.'
  if (value.length > MAX_KEYBINDINGS_TEXT) return `That is ${value.length} characters; the keyboard shortcuts hold at most ${MAX_KEYBINDINGS_TEXT}.`
  try {
    mkdirSync(editorDir(), { recursive: true })
    const temp = `${fileOf()}.${process.pid}.tmp`
    writeFileSync(temp, value, { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, fileOf())
    return null
  } catch {
    return 'The keyboard shortcuts could not be written on this computer.'
  }
}

/** Every command with its keys now, in words, for agents (read-only). */
export function describeCommands(mac: boolean = process.platform === 'darwin'): string {
  const map = keymap(defaults, readKeybindings().text, mac)
  const lines = ['The Editor’s commands, with the keys that run them on this computer (the person’s own keys over the defaults):', '']
  for (const one of COMMANDS) {
    const keys = map.bindings.filter((b) => b.command === one.id).map((b) => `${sayKey(b.parts, mac)}${b.whenText ? ` (when ${b.whenText})` : ''}${b.source === 'user' ? ' [theirs]' : ''}`)
    lines.push(`- ${one.id} — ${one.title}${keys.length ? `: ${keys.join(', ')}` : ': no key (in the palette)'}`)
  }
  if (map.problems.length) lines.push('', 'Entries in their own list that are skipped:', ...map.problems.map((one) => `- line ${one.line}: ${one.said}`))
  lines.push('', 'These are the person’s keys. This door cannot press them or change them.')
  return lines.join('\n')
}
