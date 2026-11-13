import { fileDrag, type FileDrag } from 'kehikot-module-protocol'
import { Bot, File, FileCode, FileJson, FileText, X } from 'lucide-react'
import { useEffect, useRef, useState, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react'

import { tabDirty, tabLabels, type Tab } from '@/edit/tabs'
import { cn } from '@/lib/utils'

/**
 * The strip of open files above the text, drawn as VS Code draws it: each tab with its file's icon
 * and name (and its folder when two names clash), italic while it is a preview, a dot while it has
 * unsaved changes that turns into the close button under the pointer, a small mark on a tab an agent
 * opened until the person touches it.
 *
 * Mouse: a press activates, a double-click keeps a preview, a middle-click closes, a drag reorders
 * (or carries the file out, in the protocol's drag format), a right-click opens the tab's menu; the
 * strip scrolls sideways when it overflows and keeps the active tab in view. A file dropped on the
 * strip opens at that place.
 *
 * Keyboard (the ARIA tabs pattern): ←/→, Home/End move along the strip and activate; Delete closes;
 * Shift+F10 or the menu key opens the tab's menu. Everything else is a command (`commands/list.ts`).
 */

/** What carries a tab being reordered inside this strip. Not a file format: it never leaves this page. */
const TAB_TYPE = 'application/x-kehikot-editor-tab'

const CODE = /\.(m?[jt]sx?|c[jt]s|py|rs|go|rb|lua|swift|kt|java|c|h|cc|cpp|hpp|cs|php|sh|zsh|bash|css|scss|less|html?|vue|svelte|sql|tex)$/i

function IconFor({ name }: { name: string }) {
  const className = 'size-3.5 shrink-0 opacity-70'
  if (/\.json[c5]?$/i.test(name)) return <FileJson className={className} aria-hidden />
  if (CODE.test(name)) return <FileCode className={className} aria-hidden />
  if (/\.(md|mdx|txt|rst|adoc|org)$/i.test(name)) return <FileText className={className} aria-hidden />
  return <File className={className} aria-hidden />
}

export interface TabStripProps {
  tabs: Tab[]
  active: string | null
  projectPath: string | null
  /** The id of the panel the tabs control. */
  panel: string
  onActivate(id: string): void
  onClose(id: string): void
  onPin(id: string): void
  onMove(id: string, to: number): void
  onMenu(id: string, x: number, y: number): void
  /** A file dropped on the strip, at an index of it. */
  onDropFile(file: FileDrag, at: number): void
  onFocusChange?(focused: boolean): void
}

export function TabStrip({ tabs, active, projectPath, panel, onActivate, onClose, onPin, onMove, onMenu, onDropFile, onFocusChange }: TabStripProps) {
  const strip = useRef<HTMLDivElement | null>(null)
  const [dropAt, setDropAt] = useState<number | null>(null)
  const labels = tabLabels(tabs.map((tab) => tab.relative ?? tab.path))

  /* The active tab is kept in view. */
  useEffect(() => {
    const element = strip.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
    element?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [active, tabs.length])

  /* A vertical wheel scrolls the strip sideways, as a strip of tabs does. */
  useEffect(() => {
    const element = strip.current
    if (!element) return
    const wheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return
      element.scrollLeft += event.deltaY
      event.preventDefault()
    }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => element.removeEventListener('wheel', wheel)
  }, [])

  /** The index a drop at this x lands at: before the first tab whose middle is right of it. */
  const indexAt = (x: number) => {
    const elements = [...(strip.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])]
    for (const [index, element] of elements.entries()) {
      const box = element.getBoundingClientRect()
      if (x < box.left + box.width / 2) return index
    }
    return elements.length
  }

  const focusTab = (index: number) => {
    const tab = tabs[(index + tabs.length) % tabs.length]
    if (!tab) return
    onActivate(tab.id)
    requestAnimationFrame?.(() => strip.current?.querySelector<HTMLElement>(`[data-tab="${tab.id}"]`)?.focus())
  }

  const onKeyDown = (event: ReactKeyboardEvent, index: number, tab: Tab) => {
    if (event.altKey || event.metaKey || event.ctrlKey) return
    if (event.key === 'ArrowRight') focusTab(index + 1)
    else if (event.key === 'ArrowLeft') focusTab(index - 1)
    else if (event.key === 'Home') focusTab(0)
    else if (event.key === 'End') focusTab(tabs.length - 1)
    else if (event.key === 'Delete') onClose(tab.id)
    else if (event.key === 'Enter' || event.key === ' ') onActivate(tab.id)
    else if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      const box = (event.currentTarget as HTMLElement).getBoundingClientRect()
      onMenu(tab.id, box.left + 8, box.bottom)
    } else return
    event.preventDefault()
  }

  const onDragOver = (event: ReactDragEvent) => {
    const types = Array.from(event.dataTransfer.types)
    if (!types.includes(TAB_TYPE) && !fileDrag.offered(event.dataTransfer)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = types.includes(TAB_TYPE) ? 'move' : 'copy'
    setDropAt(indexAt(event.clientX))
  }

  const onDrop = (event: ReactDragEvent) => {
    const at = indexAt(event.clientX)
    setDropAt(null)
    const moving = event.dataTransfer.getData(TAB_TYPE)
    if (moving && tabs.some((tab) => tab.id === moving)) {
      event.preventDefault()
      event.stopPropagation()
      onMove(moving, at)
      return
    }
    const file = fileDrag.read(event.dataTransfer, { project: projectPath })
    if (!file) return
    event.preventDefault()
    event.stopPropagation()
    onDropFile(file, at)
  }

  if (!tabs.length) return null

  return (
    <div
      ref={strip}
      role="tablist"
      aria-label="Open files"
      data-testid="tabs"
      className="ktabs bg-card flex h-8 min-w-0 shrink-0 items-stretch overflow-x-auto overflow-y-hidden border-b"
      onDragOver={onDragOver}
      onDragLeave={() => setDropAt(null)}
      onDrop={onDrop}
      onFocus={() => onFocusChange?.(true)}
      onBlur={() => onFocusChange?.(false)}
    >
      {tabs.map((tab, index) => {
        const selected = tab.id === active
        const unsaved = tabDirty(tab)
        const { name, folder } = labels[index]!
        const where = tab.relative ?? tab.path
        return (
          <div
            key={tab.id}
            role="tab"
            data-tab={tab.id}
            data-testid="tab"
            aria-selected={selected}
            aria-controls={panel}
            tabIndex={selected ? 0 : -1}
            title={`${where}${unsaved ? ' — unsaved' : ''}${tab.preview ? ' — preview' : ''}${tab.agent ? ' — opened by an agent' : ''}`}
            draggable
            className={cn(
              'group relative flex max-w-56 shrink-0 cursor-default select-none items-center gap-1.5 border-r pl-2.5 pr-1 text-xs outline-none',
              selected ? 'bg-background text-foreground' : 'text-muted-foreground hover:bg-accent/60',
              'focus-visible:ring-ring focus-visible:ring-1 focus-visible:ring-inset',
              dropAt === index && 'shadow-[inset_2px_0_0_var(--ring)]',
            )}
            onMouseDown={(event) => {
              if (event.button === 1) event.preventDefault()
            }}
            onClick={() => onActivate(tab.id)}
            onAuxClick={(event) => {
              if (event.button !== 1) return
              event.preventDefault()
              onClose(tab.id)
            }}
            onDoubleClick={() => onPin(tab.id)}
            onContextMenu={(event) => {
              event.preventDefault()
              onMenu(tab.id, event.clientX, event.clientY)
            }}
            onKeyDown={(event) => onKeyDown(event, index, tab)}
            onDragStart={(event) => {
              event.dataTransfer.setData(TAB_TYPE, tab.id)
              if (projectPath && tab.relative) fileDrag.set(event.dataTransfer, { project: projectPath, path: tab.relative })
              event.dataTransfer.effectAllowed = 'copyMove'
            }}
          >
            {selected ? <span aria-hidden className="bg-ring absolute inset-x-0 top-0 h-px" /> : null}
            <IconFor name={name} />
            <span className={cn('min-w-0 truncate', tab.preview && 'italic')} data-testid="tab-name">
              {name}
            </span>
            {folder ? <span className="text-muted-foreground min-w-0 truncate text-[0.65rem]">{folder}</span> : null}
            {tab.agent ? (
              <span title="Opened by an agent" data-testid="tab-agent" className="text-muted-foreground shrink-0">
                <Bot className="size-3" aria-label="Opened by an agent" />
              </span>
            ) : null}
            <button
              type="button"
              tabIndex={-1}
              aria-label={`Close ${name}${unsaved ? ' (unsaved)' : ''}`}
              data-testid="tab-close"
              className={cn(
                'hover:bg-accent relative flex size-4 shrink-0 items-center justify-center rounded-sm',
                !selected && !unsaved && 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100',
              )}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation()
                onClose(tab.id)
              }}
            >
              {unsaved ? (
                <>
                  <span aria-hidden data-testid="tab-unsaved" className="size-2 rounded-full bg-[var(--unsaved)] group-hover:hidden" />
                  <X aria-hidden className="hidden size-3 group-hover:block" />
                </>
              ) : (
                <X aria-hidden className="size-3" />
              )}
            </button>
          </div>
        )
      })}
      {dropAt === tabs.length ? <span aria-hidden className="bg-ring w-0.5 shrink-0" /> : null}
    </div>
  )
}
