import {
  SearchQuery,
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll,
  replaceNext,
  setSearchQuery,
} from '@codemirror/search'
import { StateEffect, StateField, type EditorState } from '@codemirror/state'
import type { EditorView, Panel } from '@codemirror/view'

/**
 * The find box over the text (⌘F) and its replace row (⌥⌘F / Ctrl+H): CodeMirror's own search —
 * its query, its highlighting of every match, its find next and replace, each an undoable
 * transaction — under a panel drawn to look like the rest of the page, with what VS Code's find box
 * has: match case, whole word and regular expression toggles, "3 of 12", Enter and Shift+Enter for
 * next and previous, Replace and Replace all, and Escape to close.
 *
 * DOM only, no React: CodeMirror owns the panel's life.
 */

/** Show or hide the replace row. */
export const showReplace = StateEffect.define<boolean>()

export const replaceShown = StateField.define<boolean>({
  create: () => false,
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(showReplace)) value = effect.value
    return value
  },
})

/** At most this many matches are counted; past it the count says "10000+". */
export const COUNT_LIMIT = 10_000

/** How many matches the query has in the document, and which one the selection is on (1-based, 0: none). */
export function countMatches(state: EditorState, query: SearchQuery): { total: number; current: number; capped: boolean } {
  if (!query.valid || !query.search) return { total: 0, current: 0, capped: false }
  const cursor = query.getCursor(state) as Iterator<{ from: number; to: number }>
  const main = state.selection.main
  let total = 0
  let current = 0
  for (let step = cursor.next(); !step.done; step = cursor.next()) {
    total += 1
    if (step.value.from === main.from && step.value.to === main.to) current = total
    if (total >= COUNT_LIMIT) return { total, current, capped: true }
  }
  return { total, current, capped: false }
}

/** "3 of 12", "No results", or a sentence when the expression cannot be read. */
export function countSaid(state: EditorState, query: SearchQuery): string {
  if (!query.search) return ''
  if (!query.valid) return 'Not a valid expression'
  const { total, current, capped } = countMatches(state, query)
  if (!total) return 'No results'
  return `${current || '?'} of ${total}${capped ? '+' : ''}`
}

function button(label: string, title: string, onClick: () => void, extra: Partial<HTMLButtonElement> = {}): HTMLButtonElement {
  const one = document.createElement('button')
  one.type = 'button'
  one.textContent = label
  one.title = title
  one.setAttribute('aria-label', title)
  one.className = 'kfind-button'
  one.addEventListener('mousedown', (event) => event.preventDefault())
  one.addEventListener('click', onClick)
  Object.assign(one, extra)
  return one
}

function toggle(label: string, title: string, onChange: (on: boolean) => void): HTMLButtonElement {
  const one = button(label, title, () => {
    const on = one.getAttribute('aria-pressed') !== 'true'
    one.setAttribute('aria-pressed', String(on))
    onChange(on)
  })
  one.setAttribute('aria-pressed', 'false')
  one.classList.add('kfind-toggle')
  return one
}

export function createFindPanel(view: EditorView): Panel {
  const dom = document.createElement('div')
  dom.className = 'kfind'
  dom.setAttribute('role', 'search')
  dom.setAttribute('aria-label', 'Find in file')

  const field = (placeholder: string, label: string) => {
    const input = document.createElement('input')
    input.type = 'text'
    input.placeholder = placeholder
    input.setAttribute('aria-label', label)
    input.className = 'kfind-input'
    input.spellcheck = false
    input.setAttribute('main-field', 'true')
    return input
  }
  const find = field('Find', 'Find')
  const replace = field('Replace', 'Replace')
  replace.removeAttribute('main-field')
  const count = document.createElement('span')
  count.className = 'kfind-count'
  count.setAttribute('aria-live', 'polite')
  count.setAttribute('data-testid', 'find-count')

  const now = getSearchQuery(view.state)
  find.value = now.search
  replace.value = now.replace
  let flags = { caseSensitive: now.caseSensitive, wholeWord: now.wholeWord, regexp: now.regexp }

  const commit = () => {
    const query = new SearchQuery({ search: find.value, replace: replace.value, ...flags })
    if (!query.eq(getSearchQuery(view.state))) view.dispatch({ effects: setSearchQuery.of(query) })
    else sayCount()
  }
  const sayCount = () => {
    count.textContent = countSaid(view.state, getSearchQuery(view.state))
    find.setAttribute('aria-invalid', String(Boolean(find.value) && !getSearchQuery(view.state).valid))
  }

  const caseToggle = toggle('Aa', 'Match case', (on) => ((flags = { ...flags, caseSensitive: on }), commit()))
  const wordToggle = toggle('ab', 'Match whole word', (on) => ((flags = { ...flags, wholeWord: on }), commit()))
  const regexToggle = toggle('.*', 'Use regular expression', (on) => ((flags = { ...flags, regexp: on }), commit()))
  caseToggle.setAttribute('aria-pressed', String(flags.caseSensitive))
  wordToggle.setAttribute('aria-pressed', String(flags.wholeWord))
  regexToggle.setAttribute('aria-pressed', String(flags.regexp))
  wordToggle.style.textDecoration = 'underline'

  const previous = button('↑', 'Previous match (Shift+Enter)', () => (commit(), findPrevious(view), sayCount()))
  const next = button('↓', 'Next match (Enter)', () => (commit(), findNext(view), sayCount()))
  const close = button('×', 'Close (Escape)', () => closeSearchPanel(view))
  const expand = button('›', 'Toggle replace', () => view.dispatch({ effects: showReplace.of(!view.state.field(replaceShown, false)) }))
  expand.classList.add('kfind-expand')

  const replaceOne = button('Replace', 'Replace this match', () => (commit(), replaceNext(view), sayCount()))
  const replaceEvery = button('All', 'Replace all matches', () => (commit(), replaceAll(view), sayCount()))
  replaceOne.classList.add('kfind-word')
  replaceEvery.classList.add('kfind-word')

  const findRow = document.createElement('div')
  findRow.className = 'kfind-row'
  findRow.append(find, caseToggle, wordToggle, regexToggle, count, previous, next, close)
  const replaceRow = document.createElement('div')
  replaceRow.className = 'kfind-row'
  replaceRow.append(replace, replaceOne, replaceEvery)
  const rows = document.createElement('div')
  rows.className = 'kfind-rows'
  rows.append(findRow, replaceRow)
  dom.append(expand, rows)

  const keys = (event: KeyboardEvent, which: 'find' | 'replace') => {
    if (event.key === 'Enter') {
      event.preventDefault()
      commit()
      if (which === 'replace') {
        if (event.metaKey || event.ctrlKey) replaceAll(view)
        else replaceNext(view)
      } else if (event.shiftKey) findPrevious(view)
      else findNext(view)
      sayCount()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      closeSearchPanel(view)
      view.focus()
    } else if (event.key === 'F3') {
      event.preventDefault()
      commit()
      if (event.shiftKey) findPrevious(view)
      else findNext(view)
      sayCount()
    }
  }
  find.addEventListener('input', commit)
  replace.addEventListener('input', commit)
  find.addEventListener('keydown', (event) => keys(event, 'find'))
  replace.addEventListener('keydown', (event) => keys(event, 'replace'))

  const showRows = () => {
    const shown = view.state.field(replaceShown, false) ?? false
    replaceRow.hidden = !shown
    expand.setAttribute('aria-expanded', String(shown))
    expand.textContent = shown ? '⌄' : '›'
  }

  return {
    dom,
    top: true,
    mount() {
      showRows()
      sayCount()
      find.select()
    },
    update(update) {
      for (const transaction of update.transactions) {
        for (const effect of transaction.effects) {
          if (effect.is(setSearchQuery)) {
            const query = effect.value
            if (query.search !== find.value) find.value = query.search
            if (query.replace !== replace.value) replace.value = query.replace
            flags = { caseSensitive: query.caseSensitive, wholeWord: query.wholeWord, regexp: query.regexp }
            caseToggle.setAttribute('aria-pressed', String(flags.caseSensitive))
            wordToggle.setAttribute('aria-pressed', String(flags.wholeWord))
            regexToggle.setAttribute('aria-pressed', String(flags.regexp))
          }
          if (effect.is(showReplace)) {
            showRows()
            if (effect.value) replace.focus()
          }
        }
      }
      if (update.docChanged || update.selectionSet || update.transactions.some((t) => t.effects.some((e) => e.is(setSearchQuery)))) sayCount()
    },
  }
}
