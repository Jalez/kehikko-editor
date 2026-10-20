import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { HighlightStyle, bracketMatching, indentOnInput, syntaxHighlighting } from '@codemirror/language'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import { Compartment, EditorSelection, EditorState, type Extension } from '@codemirror/state'
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
 * ## One document per `generation`
 *
 * The text is set when `generation` changes — a file opened, reloaded or
 * reverted — and not on every keystroke the page hears back. The page is told
 * every change through `onChange` and holds the text; the editor holds the
 * caret, the selection and the undo history, which a reset would throw away.
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

export interface CodeEditorProps {
  /** The text to show when `generation` changes. */
  text: string
  generation: number
  eol: '\n' | '\r\n'
  language: string | null
  readOnly: boolean
  wrap: boolean
  onChange(text: string): void
  onSave(): void
}

export function CodeEditor({ text, generation, eol, language, readOnly, wrap, onChange, onSave }: CodeEditorProps) {
  const host = useRef<HTMLDivElement | null>(null)
  const view = useRef<EditorView | null>(null)
  const handlers = useRef({ onChange, onSave })
  handlers.current = { onChange, onSave }
  const compartments = useRef({ language: new Compartment(), readOnly: new Compartment(), wrap: new Compartment() })

  /* A new document per generation. */
  useEffect(() => {
    const parent = host.current
    if (!parent) return
    const { language: lang, readOnly: ro, wrap: wr } = compartments.current
    const extensions: Extension[] = [
      lineNumbers(),
      highlightActiveLineGutter(),
      history(),
      drawSelection(),
      indentOnInput(),
      bracketMatching(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      search({ top: true }),
      syntaxHighlighting(highlight),
      theme,
      EditorState.lineSeparator.of(eol),
      keymap.of([
        /* ⌘S / Ctrl-S: the explicit save, and the browser's own "save page" never opens. */
        { key: 'Mod-s', preventDefault: true, run: () => (handlers.current.onSave(), true) },
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
        indentWithTab,
      ]),
      lang.of([]),
      ro.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
      wr.of(wrap ? EditorView.lineWrapping : []),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) handlers.current.onChange(update.state.doc.toString())
      }),
    ]
    const created = new EditorView({
      parent,
      state: EditorState.create({ doc: text, extensions, selection: EditorSelection.cursor(0) }),
    })
    view.current = created
    return () => {
      created.destroy()
      if (view.current === created) view.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a document per generation, on purpose
  }, [generation])

  useEffect(() => {
    let live = true
    void loadLanguage(language).then((extension) => {
      if (!live || !view.current) return
      view.current.dispatch({ effects: compartments.current.language.reconfigure(extension ?? []) })
    })
    return () => {
      live = false
    }
  }, [language, generation])

  useEffect(() => {
    view.current?.dispatch({
      effects: compartments.current.readOnly.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
    })
  }, [readOnly, generation])

  useEffect(() => {
    view.current?.dispatch({ effects: compartments.current.wrap.reconfigure(wrap ? EditorView.lineWrapping : []) })
  }, [wrap, generation])

  return <div ref={host} data-testid="code" className="h-full min-h-0 min-w-0" />
}
