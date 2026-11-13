import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { HighlightStyle, bracketMatching, indentOnInput, syntaxHighlighting } from '@codemirror/language'
import { findNext, findPrevious, highlightSelectionMatches, openSearchPanel, search, searchKeymap } from '@codemirror/search'
import { Compartment, EditorSelection, EditorState, StateEffect, type Extension } from '@codemirror/state'
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { useEffect, useRef } from 'react'

import { createFindPanel, replaceShown, showReplace } from './find-panel.ts'
import { loadLanguage } from './languages.ts'

/**
 * The editor: CodeMirror 6, the core and only what this page uses — history,
 * search, line numbers, bracket matching, and a grammar loaded per language.
 * No autocomplete, no lint, no folding: this is a place to change a file, not
 * an IDE in a 300-pixel container.
 *
 * ## It follows the app's theme
 *
 * Every colour is a CSS variable from `index.css` — the same tokens the rest of
 * the page draws with, which `useHost` switches between light and dark on
 * `<html>` from the host's theme. So the editor has no light or dark theme of
 * its own to get out of step.
 *
 * ## One document per tab and `generation`
 *
 * One view for the page; each tab keeps its own CodeMirror state (the caret, the
 * selection, the undo history) and its scroll, swapped in when the tab is shown.
 * The text is set when a tab's `generation` changes — a file opened, reloaded or
 * reverted — and not on every keystroke the page hears back. The page is told
 * every change through `onChange` and holds the text.
 *
 * ## Line endings
 *
 * The file's own line ending is the document's separator, so a CRLF file comes
 * back CRLF and a save changes only the lines that were edited.
 */

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '12px', backgroundColor: 'var(--background)', color: 'var(--foreground)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', lineHeight: '1.5' },
  '.cm-content': { caretColor: 'var(--foreground)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--foreground)' },
  '.cm-gutters': { backgroundColor: 'var(--background)', color: 'var(--muted-foreground)', border: 'none' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--accent)' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in oklch, var(--accent) 55%, transparent)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--cm-selection)',
  },
  '.cm-selectionMatch': { backgroundColor: 'var(--cm-match)' },
  '.cm-matchingBracket': { backgroundColor: 'var(--cm-match)', outline: '1px solid var(--ring)' },
  '.cm-panels': { backgroundColor: 'var(--card)', color: 'var(--card-foreground)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--border)' },
  '.cm-textfield': { backgroundColor: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--input)' },
  '.cm-button': { backgroundImage: 'none', backgroundColor: 'var(--secondary)', color: 'var(--secondary-foreground)', border: '1px solid var(--border)' },
})

const highlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.operatorKeyword, tags.modifier, tags.controlKeyword], color: 'var(--cm-keyword)' },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: 'var(--cm-string)' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: 'var(--cm-number)' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: 'var(--cm-comment)', fontStyle: 'italic' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: 'var(--cm-function)' },
  { tag: [tags.typeName, tags.className, tags.namespace, tags.tagName], color: 'var(--cm-type)' },
  { tag: [tags.propertyName, tags.attributeName], color: 'var(--cm-property)' },
  { tag: [tags.heading], color: 'var(--cm-keyword)', fontWeight: '600' },
  { tag: [tags.link, tags.url], color: 'var(--cm-string)', textDecoration: 'underline' },
  { tag: [tags.emphasis], fontStyle: 'italic' },
  { tag: [tags.strong], fontWeight: '600' },
  { tag: [tags.inserted], color: 'var(--cm-string)' },
  { tag: [tags.deleted], color: 'var(--destructive)' },
  { tag: [tags.meta, tags.processingInstruction], color: 'var(--muted-foreground)' },
  { tag: tags.invalid, color: 'var(--destructive)' },
])

export interface EditorView2 {
  anchor: number
  head: number
  top: number
}

/** What the page can do to the editor that is showing now, for its commands. */
export interface EditorHandle {
  focus(): void
  openFind(): void
  openReplace(): void
  findNext(): void
  findPrevious(): void
  /** Put the caret at a line (1-based) and column (1-based), selecting to an end when given, in view. */
  goTo(line: number, column?: number, endLine?: number, endColumn?: number): boolean
  /** The caret's offset in the text, in UTF-16 units. */
  offset(): number
  /** The offset of a point on screen in the text, or null. */
  offsetAt(x: number, y: number): number | null
  lineCount(): number
  /** The word at an offset (for "no definition found for …"). */
  wordAt(offset: number): string
}

export interface CodeEditorProps {
  /** Which tab this is: each tab keeps its own document, caret, selection, scroll and undo history. */
  tab?: string
  /** The text to show when `generation` changes. */
  text: string
  generation: number
  eol: '\n' | '\r\n'
  language: string | null
  readOnly: boolean
  wrap: boolean
  onChange(text: string): void
  onSave(): void
  /** Where the tab was left, to restore when its document is made. */
  view?: EditorView2 | null
  /** Told where the caret and scroll are, as they move (debounced). */
  onView?(view: EditorView2): void
  /** A place to show once the text is in; `onRevealed` says it was shown. */
  reveal?: { line: number; column?: number; endLine?: number; endColumn?: number } | null
  onRevealed?(): void
  /** The editor's handle for the page's commands, or null as it goes. */
  onHandle?(handle: EditorHandle | null): void
  /** A press in the text with modifiers: true when the page took it (⌘-click: go to definition). */
  onClickWith?(press: { cmd: boolean; ctrl: boolean; alt: boolean; shift: boolean }, offset: number): boolean
  /** The context menu asked for at a point in the text. */
  onMenu?(offset: number, x: number, y: number): void
  /** Focus came into or left the text (for `editorTextFocus`). */
  onFocusChange?(focused: boolean): void
  /** The tabs open now: the documents of any other are forgotten. */
  alive?: readonly string[]
}

function extensionsFor(
  compartments: { language: Compartment; readOnly: Compartment; wrap: Compartment },
  eol: '\n' | '\r\n',
  readOnly: boolean,
  wrap: boolean,
  handlers: { current: Pick<CodeEditorProps, 'onChange' | 'onSave' | 'onClickWith' | 'onMenu' | 'onFocusChange'> },
): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    history(),
    drawSelection(),
    indentOnInput(),
    bracketMatching(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    search({ top: true, createPanel: createFindPanel }),
    replaceShown,
    syntaxHighlighting(highlight),
    theme,
    EditorState.lineSeparator.of(eol),
    keymap.of([
      /* The page hears every key of its own first (`commands/keys.ts`); these are CodeMirror's editing keys. */
      ...defaultKeymap,
      ...historyKeymap,
      ...searchKeymap.filter((one) => one.key !== 'Mod-f' && one.key !== 'F3' && one.key !== 'Mod-g' && one.key !== 'Mod-Alt-g'),
      indentWithTab,
    ]),
    compartments.language.of([]),
    compartments.readOnly.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
    compartments.wrap.of(wrap ? EditorView.lineWrapping : []),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) handlers.current.onChange(update.state.doc.toString())
      if (update.focusChanged) handlers.current.onFocusChange?.(update.view.hasFocus)
    }),
    EditorView.domEventHandlers({
      mousedown(event, view) {
        if (event.button !== 0 || !(event.metaKey || event.ctrlKey || event.altKey)) return false
        const offset = view.posAtCoords({ x: event.clientX, y: event.clientY })
        if (offset === null) return false
        const took = handlers.current.onClickWith?.({ cmd: event.metaKey, ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey }, offset) ?? false
        if (took) event.preventDefault()
        return took
      },
      contextmenu(event, view) {
        if (!handlers.current.onMenu) return false
        const offset = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head
        event.preventDefault()
        /* A right-click outside the selection moves the caret there, as VS Code does. */
        const main = view.state.selection.main
        if (offset < main.from || offset > main.to) view.dispatch({ selection: EditorSelection.cursor(offset) })
        handlers.current.onMenu(offset, event.clientX, event.clientY)
        return true
      },
    }),
  ]
}

const clamp = (n: number, most: number) => Math.max(0, Math.min(n, most))

export function CodeEditor(props: CodeEditorProps) {
  const { tab = 'only', text, generation, eol, language, readOnly, wrap, view: keptView, reveal } = props
  const host = useRef<HTMLDivElement | null>(null)
  const view = useRef<EditorView | null>(null)
  const handlers = useRef(props)
  handlers.current = props
  const compartments = useRef({ language: new Compartment(), readOnly: new Compartment(), wrap: new Compartment() })
  /* Each tab's document as it was left — caret, selection, undo history — and its scroll, by tab id and generation. */
  const states = useRef(new Map<string, { generation: number; state: EditorState; top: number }>())
  const showing = useRef<string | null>(null)

  /* One view for the page's life; its state swapped per tab. */
  useEffect(() => {
    const parent = host.current
    if (!parent) return
    const created = new EditorView({ parent, state: EditorState.create({ doc: '' }) })
    /* The scroller the host's kept view reads and restores (protocol 2.70.0). */
    created.scrollDOM.setAttribute('data-kehikot-scroll', '')
    view.current = created
    let timer: ReturnType<typeof setTimeout> | null = null
    const report = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        const main = created.state.selection.main
        handlers.current.onView?.({ anchor: main.anchor, head: main.head, top: Math.round(created.scrollDOM.scrollTop) })
      }, 400)
    }
    created.scrollDOM.addEventListener('scroll', report, { passive: true })
    const listen = EditorView.updateListener.of((update) => {
      if (update.selectionSet) report()
    })
    created.dispatch({ effects: StateEffect.appendConfig.of(listen) })
    const handle: EditorHandle = {
      focus: () => created.focus(),
      openFind: () => {
        openSearchPanel(created)
        created.dispatch({ effects: showReplace.of(false) })
      },
      openReplace: () => {
        openSearchPanel(created)
        created.dispatch({ effects: showReplace.of(true) })
      },
      findNext: () => void findNext(created),
      findPrevious: () => void findPrevious(created),
      goTo: (line, column = 1, endLine, endColumn) => {
        const doc = created.state.doc
        if (line < 1) return false
        const at = doc.line(clamp(line, doc.lines) || 1)
        const from = at.from + clamp(column - 1, at.length)
        let to = from
        if (endLine !== undefined) {
          const end = doc.line(clamp(endLine, doc.lines) || 1)
          to = end.from + clamp((endColumn ?? 1) - 1, end.length)
        }
        created.dispatch({ selection: EditorSelection.range(from, to), effects: EditorView.scrollIntoView(from, { y: 'center' }) })
        created.focus()
        return true
      },
      offset: () => created.state.selection.main.head,
      offsetAt: (x, y) => created.posAtCoords({ x, y }),
      lineCount: () => created.state.doc.lines,
      wordAt: (offset) => {
        const word = created.state.wordAt(offset)
        return word ? created.state.sliceDoc(word.from, word.to) : ''
      },
    }
    handlers.current.onHandle?.(handle)
    return () => {
      if (timer) clearTimeout(timer)
      handlers.current.onHandle?.(null)
      created.destroy()
      if (view.current === created) view.current = null
    }
  }, [])

  /* The tab shown, or its generation moved (opened, reloaded, reverted): swap the document in. */
  useEffect(() => {
    const current = view.current
    if (!current) return
    const was = showing.current
    if (was !== null && states.current.has(was)) {
      const kept = states.current.get(was)!
      states.current.set(was, { ...kept, state: current.state, top: current.scrollDOM.scrollTop })
    }
    let entry = states.current.get(tab)
    if (!entry || entry.generation !== generation) {
      const extensions = extensionsFor(compartments.current, eol, readOnly, wrap, handlers)
      const length = text.length
      const selection = keptView && !reveal ? EditorSelection.range(clamp(keptView.anchor, length), clamp(keptView.head, length)) : EditorSelection.cursor(0)
      entry = { generation, state: EditorState.create({ doc: text, extensions, selection }), top: keptView && !reveal ? keptView.top : 0 }
      states.current.set(tab, entry)
    }
    current.setState(entry.state)
    showing.current = tab
    const top = entry.top
    requestAnimationFrame?.(() => {
      if (view.current === current && showing.current === tab) current.scrollDOM.scrollTop = top
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a document per tab and generation, on purpose
  }, [tab, generation])

  /* Forget the documents of tabs that closed. */
  const alive = props.alive?.join('\0') ?? null
  useEffect(() => {
    if (alive === null) return
    const keep = new Set(alive.split('\0'))
    for (const id of [...states.current.keys()]) if (!keep.has(id)) states.current.delete(id)
  }, [alive])

  useEffect(() => {
    let live = true
    void loadLanguage(language).then((extension) => {
      if (!live || !view.current) return
      view.current.dispatch({ effects: compartments.current.language.reconfigure(extension ?? []) })
    })
    return () => {
      live = false
    }
  }, [language, generation, tab])

  useEffect(() => {
    view.current?.dispatch({
      effects: compartments.current.readOnly.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
    })
  }, [readOnly, generation, tab])

  useEffect(() => {
    view.current?.dispatch({ effects: compartments.current.wrap.reconfigure(wrap ? EditorView.lineWrapping : []) })
  }, [wrap, generation, tab])

  /* A place to show: once the document is in. */
  useEffect(() => {
    if (!reveal || !view.current) return
    const current = view.current
    const doc = current.state.doc
    const at = doc.line(clamp(reveal.line, doc.lines) || 1)
    const from = at.from + clamp((reveal.column ?? 1) - 1, at.length)
    let to = from
    if (reveal.endLine !== undefined) {
      const end = doc.line(clamp(reveal.endLine, doc.lines) || 1)
      to = end.from + clamp((reveal.endColumn ?? 1) - 1, end.length)
    }
    current.dispatch({ selection: EditorSelection.range(from, to), effects: EditorView.scrollIntoView(from, { y: 'center' }) })
    handlers.current.onRevealed?.()
  }, [reveal, tab, generation])

  return <div ref={host} data-testid="code" className="h-full min-h-0 min-w-0" />
}
