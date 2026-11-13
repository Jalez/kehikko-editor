import { ChevronRight, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'

import { cn } from '@/lib/utils'
import type { SearchAnswer, SearchQuery } from '@/wire/api'

/**
 * Search in project (⇧⌘F), inside the page beside the text: the query with match case, whole word
 * and regular expression, files to include and to exclude (globs), and the results grouped by file
 * with their counts and each line with the match marked. A press or Enter opens the file in a
 * preview tab at that line.
 *
 * The search runs on the module's server, inside the project, with `.gitignore`, `.git`,
 * `node_modules` and binaries left out, and bounded in results, file size and time; a newer query
 * cancels the older one there. Replacing across the project is not offered.
 */

export interface SearchState extends SearchQuery {
  /** Whether the include and exclude fields are shown. */
  details: boolean
}

export const NO_SEARCH: SearchState = { query: '', caseSensitive: false, wholeWord: false, regex: false, include: [], exclude: [], details: false }

const globs = (text: string) =>
  text
    .split(',')
    .map((one) => one.trim())
    .filter(Boolean)
    .slice(0, 32)

/** "12 results in 4 files", with what was left out. */
export function resultsSaid(answer: SearchAnswer): string {
  if (answer.error) return answer.error
  if (!answer.total) return answer.timedOut ? 'No results before the search ran out of time.' : 'No results.'
  const files = answer.files.length
  const base = `${answer.total} ${answer.total === 1 ? 'result' : 'results'} in ${files} ${files === 1 ? 'file' : 'files'}`
  if (answer.truncated) return `${base} — the first ones only; narrow the search to see the rest.`
  if (answer.timedOut) return `${base} — the search ran out of time; narrow it to search everything.`
  return `${base}.`
}

type Row = { kind: 'file'; relative: string; count: number; open: boolean } | { kind: 'match'; relative: string; index: number; line: number; column: number; length: number; preview: string; previewStart: number }

export function SearchView({
  state,
  onState,
  search,
  onOpen,
  onClose,
  focusSignal,
  onFocusChange,
}: {
  state: SearchState
  onState(next: SearchState): void
  /** Ask the server; resolves with the answer, or null when a newer query took its place. */
  search(query: SearchQuery): Promise<SearchAnswer | null>
  onOpen(relative: string, line: number, column: number, length: number, keep: boolean): void
  onClose(): void
  /** Changes when the view should take focus (⇧⌘F pressed again). */
  focusSignal: number
  onFocusChange?(focused: boolean): void
}) {
  const [answer, setAnswer] = useState<SearchAnswer | null>(null)
  const [busy, setBusy] = useState(false)
  const [closed, setClosed] = useState<Set<string>>(new Set())
  const [cursor, setCursor] = useState(0)
  const input = useRef<HTMLInputElement | null>(null)
  const tree = useRef<HTMLDivElement | null>(null)
  const [includeText, setIncludeText] = useState(state.include.join(', '))
  const [excludeText, setExcludeText] = useState(state.exclude.join(', '))

  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [focusSignal])

  /* Asked a moment after typing stops; an older answer arriving late is dropped. */
  const asked = JSON.stringify([state.query, state.caseSensitive, state.wholeWord, state.regex, state.include, state.exclude])
  useEffect(() => {
    if (!state.query) {
      setAnswer(null)
      setBusy(false)
      return
    }
    let live = true
    setBusy(true)
    const timer = setTimeout(() => {
      void search({ query: state.query, caseSensitive: state.caseSensitive, wholeWord: state.wholeWord, regex: state.regex, include: state.include, exclude: state.exclude }).then((got) => {
        if (!live || got === null) return
        setAnswer(got)
        setBusy(false)
        setCursor(0)
      })
    }, 250)
    return () => {
      live = false
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- asked is the query, whole
  }, [asked, search])

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const file of answer?.files ?? []) {
      const open = !closed.has(file.relative)
      out.push({ kind: 'file', relative: file.relative, count: file.count, open })
      if (open) file.matches.forEach((match, index) => out.push({ kind: 'match', relative: file.relative, index, ...match }))
    }
    return out
  }, [answer, closed])

  useEffect(() => {
    tree.current?.querySelector<HTMLElement>(`[data-row="${cursor}"]`)?.scrollIntoView?.({ block: 'nearest' })
  }, [cursor])

  const openRow = (row: Row | undefined, keep: boolean) => {
    if (!row) return
    if (row.kind === 'file') {
      const next = new Set(closed)
      if (next.has(row.relative)) next.delete(row.relative)
      else next.add(row.relative)
      setClosed(next)
      return
    }
    onOpen(row.relative, row.line, row.column, row.length, keep)
  }

  const onTreeKey = (event: ReactKeyboardEvent) => {
    const row = rows[cursor]
    if (event.key === 'ArrowDown') setCursor(Math.min(rows.length - 1, cursor + 1))
    else if (event.key === 'ArrowUp') setCursor(Math.max(0, cursor - 1))
    else if (event.key === 'Home') setCursor(0)
    else if (event.key === 'End') setCursor(rows.length - 1)
    else if (event.key === 'Enter') openRow(row, event.metaKey || event.ctrlKey)
    else if (event.key === 'ArrowLeft' && row) {
      if (row.kind === 'file' && row.open) openRow(row, false)
      else if (row.kind === 'match') setCursor(rows.findIndex((one) => one.kind === 'file' && one.relative === row.relative))
    } else if (event.key === 'ArrowRight' && row?.kind === 'file' && !row.open) openRow(row, false)
    else if (event.key === 'Escape') onClose()
    else return
    event.preventDefault()
  }

  const toggle = (key: 'caseSensitive' | 'wholeWord' | 'regex', label: string, title: string) => (
    <button
      type="button"
      aria-pressed={state[key]}
      title={title}
      aria-label={title}
      onClick={() => onState({ ...state, [key]: !state[key] })}
      className={cn('flex h-6 min-w-6 items-center justify-center rounded-sm px-1 font-mono text-[11px]', state[key] ? 'bg-accent text-foreground ring-ring ring-1' : 'text-muted-foreground hover:bg-accent')}
    >
      {label}
    </button>
  )

  return (
    <aside
      aria-label="Search in project"
      data-testid="search-view"
      className="bg-card flex h-full min-h-0 w-full min-w-0 flex-col border-r text-xs"
      onFocus={() => onFocusChange?.(true)}
      onBlur={() => onFocusChange?.(false)}
    >
      <div className="flex items-center gap-1 border-b px-2 py-1">
        <span className="text-muted-foreground flex-1 text-[0.65rem] font-medium uppercase tracking-wide">Search in project</span>
        <button type="button" aria-label="Close search" title="Close search (Escape)" onClick={onClose} className="hover:bg-accent flex size-5 items-center justify-center rounded-sm">
          <X className="size-3" aria-hidden />
        </button>
      </div>
      <div className="flex flex-col gap-1 border-b p-2">
        <div className="flex items-center gap-0.5">
          <input
            ref={input}
            type="search"
            role="searchbox"
            aria-label="Search"
            placeholder="Search"
            spellCheck={false}
            value={state.query}
            onChange={(event) => onState({ ...state, query: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                if (rows.length) {
                  setCursor(rows.findIndex((one) => one.kind === 'match'))
                  tree.current?.focus()
                }
              } else if (event.key === 'ArrowDown' && rows.length) {
                event.preventDefault()
                tree.current?.focus()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                onClose()
              }
            }}
            aria-invalid={Boolean(answer?.error)}
            className="bg-background focus-visible:ring-ring h-6 min-w-0 flex-1 rounded-sm border px-1.5 outline-none focus-visible:ring-1"
          />
          {toggle('caseSensitive', 'Aa', 'Match case')}
          {toggle('wholeWord', 'ab', 'Match whole word')}
          {toggle('regex', '.*', 'Use regular expression')}
          <button
            type="button"
            aria-expanded={state.details}
            title="Files to include and exclude"
            aria-label="Files to include and exclude"
            onClick={() => onState({ ...state, details: !state.details })}
            className="text-muted-foreground hover:bg-accent flex h-6 min-w-6 items-center justify-center rounded-sm"
          >
            …
          </button>
        </div>
        {state.details ? (
          <>
            <label className="text-muted-foreground flex flex-col gap-0.5 text-[0.65rem]">
              files to include
              <input
                spellCheck={false}
                value={includeText}
                placeholder="e.g. src/**, *.ts"
                onChange={(event) => setIncludeText(event.target.value)}
                onBlur={() => onState({ ...state, include: globs(includeText) })}
                onKeyDown={(event) => event.key === 'Enter' && onState({ ...state, include: globs(includeText) })}
                className="bg-background text-foreground h-6 rounded-sm border px-1.5 text-xs outline-none"
              />
            </label>
            <label className="text-muted-foreground flex flex-col gap-0.5 text-[0.65rem]">
              files to exclude
              <input
                spellCheck={false}
                value={excludeText}
                placeholder="e.g. **/*.test.ts, dist"
                onChange={(event) => setExcludeText(event.target.value)}
                onBlur={() => onState({ ...state, exclude: globs(excludeText) })}
                onKeyDown={(event) => event.key === 'Enter' && onState({ ...state, exclude: globs(excludeText) })}
                className="bg-background text-foreground h-6 rounded-sm border px-1.5 text-xs outline-none"
              />
            </label>
          </>
        ) : null}
        <p role="status" aria-live="polite" data-testid="search-said" className={cn('text-[0.7rem]', answer?.error ? 'text-destructive' : 'text-muted-foreground')}>
          {busy ? 'Searching…' : answer ? resultsSaid(answer) : state.query ? '' : 'Type to search the project’s files.'}
        </p>
      </div>
      <div
        ref={tree}
        role="tree"
        aria-label="Results"
        tabIndex={0}
        onKeyDown={onTreeKey}
        aria-activedescendant={rows.length ? `search-row-${cursor}` : undefined}
        className="min-h-0 flex-1 overflow-y-auto py-1 outline-none"
      >
        {rows.map((row, index) =>
          row.kind === 'file' ? (
            <div
              key={`f:${row.relative}`}
              id={`search-row-${index}`}
              role="treeitem"
              aria-expanded={row.open}
              aria-level={1}
              aria-selected={index === cursor}
              data-row={index}
              title={row.relative}
              onClick={() => (setCursor(index), openRow(row, false))}
              className={cn('flex cursor-default items-center gap-1 px-1.5 py-0.5', index === cursor && 'bg-accent text-accent-foreground')}
            >
              <ChevronRight aria-hidden className={cn('size-3 shrink-0 transition-transform', row.open && 'rotate-90')} />
              <span className="min-w-0 truncate font-medium">{row.relative.split('/').pop()}</span>
              <span className="text-muted-foreground min-w-0 flex-1 truncate text-[0.65rem]">{row.relative.split('/').slice(0, -1).join('/')}</span>
              <span className="bg-secondary text-secondary-foreground rounded-full px-1.5 text-[0.65rem]">{row.count}</span>
            </div>
          ) : (
            <div
              key={`m:${row.relative}:${row.index}`}
              id={`search-row-${index}`}
              role="treeitem"
              aria-level={2}
              aria-selected={index === cursor}
              data-row={index}
              data-testid="search-match"
              onClick={() => (setCursor(index), openRow(row, false))}
              onDoubleClick={() => openRow(row, true)}
              className={cn('flex cursor-default items-baseline gap-1.5 py-0.5 pr-1.5 pl-6 font-mono text-[11px]', index === cursor && 'bg-accent text-accent-foreground')}
            >
              <span className="text-muted-foreground shrink-0 text-[0.6rem]">{row.line}</span>
              <span className="min-w-0 truncate whitespace-pre">
                {row.preview.slice(0, Math.max(0, row.column - row.previewStart))}
                <mark className="text-foreground rounded-sm bg-[var(--cm-match)]">{row.preview.slice(Math.max(0, row.column - row.previewStart), Math.max(0, row.column - row.previewStart) + row.length)}</mark>
                {row.preview.slice(Math.max(0, row.column - row.previewStart) + row.length)}
              </span>
            </div>
          ),
        )}
      </div>
    </aside>
  )
}
