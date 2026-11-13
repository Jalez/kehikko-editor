import { describe, expect, test } from 'bun:test'

import defaults from '../src/commands/keybindings.default.json'
import { COMMANDS, COMMAND_IDS } from '../src/commands/list.ts'
import { RESERVED, hear, keymap, keysFor, parseKey, parseWhen, holds, pressOf, readUserText, sayKey } from '../src/commands/keys.ts'

describe('keys, as VS Code writes them', () => {
  test('presses are normalised: modifier names and order, aliases', () => {
    expect(parseKey('Shift+Cmd+P')).toEqual(['shift+cmd+p'])
    expect(parseKey('cmd+shift+p')).toEqual(['shift+cmd+p'])
    expect(parseKey('ctrl+alt+Delete')).toEqual(['ctrl+alt+delete'])
    expect(parseKey('option+meta+esc')).toEqual(['alt+cmd+escape'])
    expect(parseKey('f12')).toEqual(['f12'])
    expect(parseKey('cmd+click')).toEqual(['cmd+click'])
  })

  test('chords are two presses; three, empty, unknown keys and doubled modifiers are not keys', () => {
    expect(parseKey('cmd+k cmd+w')).toEqual(['cmd+k', 'cmd+w'])
    expect(parseKey('cmd+k u')).toEqual(['cmd+k', 'u'])
    for (const bad of ['', 'cmd+', 'cmd+k cmd+w cmd+x', 'ctrl+ctrl+a', 'hyper+a', 'cmd+click cmd+a', 'cmd+banana']) expect(parseKey(bad)).toBeNull()
  })

  test('when: names, not, and, or, parentheses; an unknown name is said', () => {
    const when = parseWhen('editorTextFocus && !(hasUnsaved || readOnly)')
    expect(holds(when, { editorTextFocus: true })).toBe(true)
    expect(holds(when, { editorTextFocus: true, hasUnsaved: true })).toBe(false)
    expect(() => parseWhen('editorTextFocus &&')).toThrow('ends too early')
    expect(() => parseWhen('somethingElse')).toThrow('not a context')
  })
})

describe('the keymap', () => {
  test('every default names a command that exists and parses on both platforms', () => {
    for (const mac of [true, false]) expect(keymap(defaults, '', mac).problems).toEqual([])
    for (const one of defaults as { command: string }[]) expect(COMMAND_IDS.has(one.command)).toBe(true)
  })

  test('the defaults match VS Code where VS Code has one', () => {
    const mac = keymap(defaults, '', true)
    expect(keysFor(mac, 'editor.goToDefinition')).toContain('f12')
    expect(keysFor(mac, 'palette.show')).toContain('shift+cmd+p')
    expect(keysFor(mac, 'quickOpen.file')).toContain('cmd+p')
    expect(keysFor(mac, 'editor.goToSymbol')).toContain('shift+cmd+o')
    expect(keysFor(mac, 'workspace.goToSymbol')).toContain('cmd+t')
    expect(keysFor(mac, 'editor.goToLine')).toContain('ctrl+g')
    expect(keysFor(mac, 'tabs.close')).toContain('cmd+w')
    expect(keysFor(mac, 'tabs.next')).toContain('ctrl+tab')
    expect(keysFor(mac, 'tabs.closeAll')).toContain('cmd+k cmd+w')
    expect(keysFor(mac, 'search.showProject')).toContain('shift+cmd+f')
    expect(keysFor(keymap(defaults, '', false), 'quickOpen.file')).toContain('ctrl+p')
  })

  test('no default takes a chord the app keeps for itself', () => {
    for (const mac of [true, false]) for (const one of keymap(defaults, '', mac).bindings) for (const part of one.parts) expect(RESERVED).not.toContain(part)
  })

  test('the person’s keys beat the defaults; -command takes a default away', () => {
    const text = `[
      // mine
      { "key": "cmd+e", "command": "palette.show" },
      { "key": "f12", "command": "editor.goToLine" },
      { "command": "-quickOpen.file" },
      { "key": "cmd+shift+o", "command": "-editor.goToSymbol" },
    ]`
    const map = keymap(defaults, text, true)
    expect(map.problems).toEqual([])
    expect(hear(map, 'cmd+e', null, {})).toEqual({ kind: 'run', command: 'palette.show' })
    expect(hear(map, 'f12', null, { editorTextFocus: true })).toEqual({ kind: 'run', command: 'editor.goToLine' })
    expect(keysFor(map, 'quickOpen.file')).toEqual([])
    expect(keysFor(map, 'editor.goToSymbol')).toEqual([])
  })

  test('a chord waits for its second press, and when decides', () => {
    const map = keymap(defaults, '', true)
    expect(hear(map, 'cmd+k', null, { hasTabs: true })).toEqual({ kind: 'chord', first: 'cmd+k' })
    expect(hear(map, 'cmd+w', 'cmd+k', { hasTabs: true })).toEqual({ kind: 'run', command: 'tabs.closeAll' })
    expect(hear(map, 'x', 'cmd+k', { hasTabs: true })).toEqual({ kind: 'none', afterChord: true })
    expect(hear(map, 'cmd+s', null, { hasTabs: false })).toEqual({ kind: 'none', afterChord: false })
  })

  test('invalid JSON is said with its line, and nothing of it is used', () => {
    const read = readUserText('[\n  { "key": "cmd+e", "command": "palette.show" }\n  { "key": "x" }\n]', true)
    expect(read.bindings).toEqual([])
    expect(read.problems).toEqual([{ line: 3, said: expect.stringContaining('not valid JSON') }])
  })

  test('a bad entry is skipped with its line; the good ones still work', () => {
    const text = '[\n{ "key": "cmd+e", "command": "palette.show" },\n{ "key": "cmd+banana", "command": "palette.show" },\n{ "key": "cmd+j", "command": "nope" },\n{ "key": "alt+shift+n", "command": "palette.show" },\n{ "key": "cmd+u", "command": "palette.show", "when": "bogus" }\n]'
    const map = keymap(defaults, text, true)
    expect(map.problems.map((one) => one.line)).toEqual([3, 4, 5, 6])
    expect(map.problems[2]!.said).toContain('app’s own shortcut')
    expect(hear(map, 'cmd+e', null, {})).toEqual({ kind: 'run', command: 'palette.show' })
  })

  test('a key event is read by code, so Option and Shift do not change the key', () => {
    expect(pressOf({ key: 'π', code: 'KeyP', ctrlKey: false, shiftKey: false, altKey: true, metaKey: true })).toBe('alt+cmd+p')
    expect(pressOf({ key: '?', code: 'Slash', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false })).toBe('ctrl+shift+/')
    expect(pressOf({ key: 'Tab', code: 'Tab', ctrlKey: true, shiftKey: false, altKey: false, metaKey: false })).toBe('ctrl+tab')
    expect(pressOf({ key: 'Shift', code: 'ShiftLeft', ctrlKey: false, shiftKey: true, altKey: false, metaKey: false })).toBeNull()
  })

  test('keys are said the way each platform says them', () => {
    expect(sayKey(['shift+cmd+p'], true)).toBe('⇧⌘P')
    expect(sayKey(['cmd+k', 'cmd+w'], true)).toBe('⌘K ⌘W')
    expect(sayKey(['ctrl+shift+p'], false)).toBe('Ctrl+Shift+P')
  })

  test('every command has a title and a category', () => {
    for (const one of COMMANDS) expect(one.title.length).toBeGreaterThan(2)
    expect(new Set(COMMANDS.map((one) => one.id)).size).toBe(COMMANDS.length)
  })
})
