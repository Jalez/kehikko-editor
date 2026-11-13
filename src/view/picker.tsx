import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'

import { cn } from '@/lib/utils'

/**
 * The one quick input, as VS Code's: the command palette, Go to file, Go to symbol in file and in
 * the project, Go to line, and the small list of several definitions. What it lists is decided by
 * the first character typed, as there: `>` commands, `@` symbols in the file, `#` symbols in the
 * project, `:` a line, nothing a file.
 *
 * A combobox over a listbox: ↑/↓ (and PageUp/PageDown, Home/End with Ctrl) move, Enter runs, Escape
 * closes and gives focus back. The page decides what each mode lists (`provide`); this only draws.
 */

export type PickMode = 'files' | 'commands' | 'symbols' | 'projectSymbols' | 'line' | 'choose'

export const PREFIX: Record<PickMode, string> = { files: '', commands: '>', symbols: '@', projectSymbols: '#', line: ':', choose: '' }

export interface PickItem {
  id: string
  label: string
  /** Muted words after the label (a folder, a container). */
  description?: string | null
  /** A line under it, or the key of a command. */
  detail?: string | null
  shortcut?: string | null
  /** Indices in `label` to mark as matched. */
  hits?: number[]
  group?: string | null
}

export interface PickList {
  items: PickItem[]
  /** A sentence instead of, or above, the items ("No matching files", "Type a line number"). */
  said?: string | null
  busy?: boolean
}

/** The mode a typed value asks for, and the query without its prefix. */
export function modeOf(value: string, fixed: PickMode | null): { mode: PickMode; query: string } {
  if (fixed === 'choose') return { mode: 'choose', query: value }
  const first = value.charAt(0)
  if (first === '>') return { mode: 'commands', query: value.slice(1).trimStart() }
  if (first === '@') return { mode: 'symbols', query: value.slice(1).trimStart() }
  if (first === '#') return { mode: 'projectSymbols', query: value.slice(1).trimStart() }
  if (first === ':') return { mode: 'line', query: value.slice(1).trimStart() }
  return { mode: 'files', query: value }
}

function Marked({ text, hits }: { text: string; hits?: number[] }): ReactNode {
  if (!hits?.length) return text
  const set = new Set(hits)
  return [...text].map((char, index) =>
    set.has(index) ? (
      <mark key={index} className="text-foreground bg-transparent font-semibold">
        {char}
      </mark>
    ) : (
      <span key={index}>{char}</span>
    ),
  )
}

export function Picker({
  initial,
  fixed = null,
  placeholder,
  provide,
  onPick,
  onClose,
}: {
  /** The value it opens with: a prefix (`>`) chooses the mode. */
  initial: string
  /** A picker that never changes mode by prefix (the list of definitions). */
  fixed?: PickMode | null
  placeholder?: string
  provide(mode: PickMode, query: string): PickList | Promise<PickList>
  onPick(mode: PickMode, item: PickItem, query: string): void
  onClose(): void
}) {
  const [value, setValue] = useState(initial)
  const [list, setList] = useState<PickList>({ items: [], busy: true })
  const [index, setIndex] = useState(0)
  const input = useRef<HTMLInputElement | null>(null)
  const listbox = useRef<HTMLDivElement | null>(null)
  const back = useRef<Element | null>(typeof document === 'undefined' ? null : document.activeElement)
  const id = useId()
  const { mode, query } = useMemo(() => modeOf(value, fixed), [value, fixed])

  useEffect(() => {
    input.current?.focus()
    const end = input.current?.value.length ?? 0
    input.current?.setSelectionRange(end, end)
    const restore = back.current
    return () => {
      if (restore instanceof HTMLElement && restore.isConnected) restore.focus()
    }
  }, [])

  /* Asked again on every change; a late answer to an older query is dropped. */
  useEffect(() => {
    let live = true
    const answer = provide(mode, query)
    if (answer instanceof Promise) {
      setList((was) => ({ ...was, busy: true }))
      void answer.then((got) => {
        if (live) {
          setList(got)
          setIndex(0)
        }
      })
    } else {
      setList(answer)
      setIndex(0)
    }
    return () => {
      live = false
    }
  }, [mode, query, provide])

  useEffect(() => {
    listbox.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.scrollIntoView?.({ block: 'nearest' })
  }, [index])

  const pick = (item: PickItem | undefined) => {
    if (!item) return
    onPick(mode, item, query)
  }

  const onKeyDown = (event: ReactKeyboardEvent) => {
    const count = list.items.length
    const move = (to: number) => setIndex(count ? Math.max(0, Math.min(count - 1, to)) : 0)
    if (event.key === 'ArrowDown') move(index + 1 >= count ? 0 : index + 1)
    else if (event.key === 'ArrowUp') move(index - 1 < 0 ? count - 1 : index - 1)
    else if (event.key === 'PageDown') move(index + 10)
    else if (event.key === 'PageUp') move(index - 10)
    else if (event.key === 'Enter') {
      if (mode === 'line' && !count) onPick(mode, { id: 'line', label: query }, query)
      else pick(list.items[index])
    } else if (event.key === 'Escape') onClose()
    else return
    event.preventDefault()
    event.stopPropagation()
  }

  const active = list.items[index]
  return (
    <div className="absolute inset-x-0 top-1 z-40 flex justify-center px-2" data-testid="picker">
      <div className="bg-popover text-popover-foreground w-full max-w-xl overflow-hidden rounded-md border shadow-lg">
        <input
          ref={input}
          role="combobox"
          aria-expanded="true"
          aria-controls={`${id}-list`}
          aria-activedescendant={active ? `${id}-${index}` : undefined}
          aria-autocomplete="list"
          aria-label={placeholder ?? 'Search'}
          placeholder={placeholder}
          spellCheck={false}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={onKeyDown}
          onBlur={(event) => {
            if (!event.relatedTarget || !(event.currentTarget.parentElement?.contains(event.relatedTarget as Node) ?? false)) onClose()
          }}
          className="bg-background w-full border-b px-3 py-1.5 text-xs outline-none"
        />
        {list.said ? (
          <p className="text-muted-foreground px-3 py-1.5 text-xs" data-testid="picker-said" role="status">
            {list.said}
          </p>
        ) : null}
        <div ref={listbox} id={`${id}-list`} role="listbox" aria-label="Results" className="max-h-72 overflow-y-auto py-1 text-xs">
          {list.items.map((item, i) => (
            <div key={item.id}>
              {item.group && item.group !== list.items[i - 1]?.group ? (
                <div className="text-muted-foreground px-3 pt-1.5 pb-0.5 text-[0.65rem] uppercase tracking-wide">{item.group}</div>
              ) : null}
              <div
                id={`${id}-${i}`}
                role="option"
                aria-selected={i === index}
                data-index={i}
                data-testid="picker-item"
                className={cn('flex cursor-default items-center gap-2 px-3 py-1', i === index ? 'bg-accent text-accent-foreground' : '')}
                onMouseDown={(event) => event.preventDefault()}
                onMouseMove={() => setIndex(i)}
                onClick={() => pick(item)}
              >
                <span className="min-w-0 truncate">
                  <Marked text={item.label} hits={item.hits} />
                </span>
                {item.description ? <span className="text-muted-foreground min-w-0 flex-1 truncate text-[0.7rem]">{item.description}</span> : <span className="flex-1" />}
                {item.detail ? <span className="text-muted-foreground shrink-0 truncate text-[0.7rem]">{item.detail}</span> : null}
                {item.shortcut ? <span className="text-muted-foreground shrink-0 font-mono text-[0.65rem]">{item.shortcut}</span> : null}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
