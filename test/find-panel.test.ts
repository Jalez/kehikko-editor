import { afterEach, describe, expect, test } from 'bun:test'
import { history, undo } from '@codemirror/commands'
import { SearchQuery, openSearchPanel, search } from '@codemirror/search'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

import { countSaid, createFindPanel, replaceShown, showReplace } from '../src/view/find-panel.ts'

/** The find box over the text: toggles, "n of m", next and previous, replace and replace all, undo. */

let view: EditorView | null = null
afterEach(() => {
  view?.destroy()
  view = null
})

function editor(doc: string) {
  view = new EditorView({ parent: document.body, state: EditorState.create({ doc, extensions: [history(), search({ top: true, createPanel: createFindPanel }), replaceShown] }) })
  openSearchPanel(view)
  const panel = view.dom.querySelector('.kfind') as HTMLElement
  const find = panel.querySelector('input[aria-label="Find"]') as HTMLInputElement
  const replace = panel.querySelector('input[aria-label="Replace"]') as HTMLInputElement
  const count = () => panel.querySelector('[data-testid="find-count"]')!.textContent
  const type = (input: HTMLInputElement, text: string) => {
    input.value = text
    input.dispatchEvent(new Event('input'))
  }
  const press = (input: HTMLInputElement, key: string, shiftKey = false) => input.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true }))
  const button = (label: string) => panel.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement
  return { view: view!, panel, find, replace, count, type, press, button }
}

describe('the find box', () => {
  test('is a search region with a Find field, the three toggles, a count, next, previous and close', () => {
    const { panel, button } = editor('one two one\n')
    expect(panel.getAttribute('role')).toBe('search')
    for (const label of ['Match case', 'Match whole word', 'Use regular expression', 'Previous match (Shift+Enter)', 'Next match (Enter)', 'Close (Escape)']) expect(button(label)).not.toBeNull()
    expect(button('Match case').getAttribute('aria-pressed')).toBe('false')
  })

  test('says how many matches there are and which one, and Enter / Shift+Enter move', () => {
    const { find, count, type, press } = editor('cat Cat cat concat\n')
    type(find, 'cat')
    expect(count()).toBe('? of 4')
    press(find, 'Enter')
    expect(count()).toBe('1 of 4')
    press(find, 'Enter')
    expect(count()).toBe('2 of 4')
    press(find, 'Enter', true)
    expect(count()).toBe('1 of 4')
  })

  test('match case, whole word and regular expression narrow it; a bad expression is said', () => {
    const { find, count, type, button } = editor('cat Cat cat concat\n')
    type(find, 'cat')
    button('Match case').click()
    expect(button('Match case').getAttribute('aria-pressed')).toBe('true')
    expect(count()).toMatch(/of 3$/)
    button('Match whole word').click()
    expect(count()).toMatch(/of 2$/)
    button('Use regular expression').click()
    type(find, 'c(at')
    expect(count()).toBe('Not a valid expression')
    expect(find.getAttribute('aria-invalid')).toBe('true')
    type(find, 'c.t')
    expect(count()).toMatch(/of 2$/)
  })

  test('Replace all replaces every match in one step that undo takes back', () => {
    const { view, find, replace, type, button, count } = editor('a-b-a-b\n')
    view.dispatch({ effects: showReplace.of(true) })
    type(find, 'a')
    type(replace, 'z')
    button('Replace all matches').click()
    expect(view.state.doc.toString()).toBe('z-b-z-b\n')
    expect(count()).toBe('No results')
    undo(view)
    expect(view.state.doc.toString()).toBe('a-b-a-b\n')
  })

  test('Replace replaces the current match and moves to the next', () => {
    const { view, find, replace, type, press, button } = editor('x y x\n')
    view.dispatch({ effects: showReplace.of(true) })
    type(find, 'x')
    type(replace, 'q')
    press(find, 'Enter')
    button('Replace this match').click()
    expect(view.state.doc.toString()).toBe('q y x\n')
  })

  test('the count stops at its bound and says so', () => {
    const state = EditorState.create({ doc: 'a'.repeat(10_050) })
    expect(countSaid(state, new SearchQuery({ search: 'a' }))).toBe('? of 10000+')
  })

  test('Escape closes it', () => {
    const { view, find, press } = editor('x\n')
    press(find, 'Escape')
    expect(view.dom.querySelector('.kfind')).toBeNull()
  })
})
