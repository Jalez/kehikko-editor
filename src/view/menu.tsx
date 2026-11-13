import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'

import { cn } from '@/lib/utils'

/**
 * A context menu at a point: the tab's menu and the text's. Every item is a command (`commands/
 * list.ts`) with the key that runs it shown beside it, so what the menu offers the keyboard reaches
 * too. Arrow keys move, Enter or Space runs, Escape or a press outside closes, and focus goes back
 * where it was.
 */

export interface MenuItem {
  /** The command it runs. */
  command: string
  label: string
  /** The key that runs the same command, as a person reads it. */
  shortcut?: string | null
  disabled?: string | null
  /** A line above this item. */
  separated?: boolean
}

export function ContextMenu({
  items,
  x,
  y,
  label,
  onRun,
  onClose,
}: {
  items: MenuItem[]
  x: number
  y: number
  label: string
  onRun(command: string): void
  onClose(): void
}) {
  const box = useRef<HTMLDivElement | null>(null)
  const [at, setAt] = useState({ x, y })
  const back = useRef<Element | null>(typeof document === 'undefined' ? null : document.activeElement)

  /* Kept inside the frame: flipped up or left when it would run off an edge. */
  useLayoutEffect(() => {
    const element = box.current
    if (!element || typeof window === 'undefined') return
    const rect = element.getBoundingClientRect()
    const left = x + rect.width > window.innerWidth ? Math.max(0, window.innerWidth - rect.width - 4) : x
    const top = y + rect.height > window.innerHeight ? Math.max(0, y - rect.height) : y
    setAt({ x: left, y: top })
  }, [x, y])

  useEffect(() => {
    const first = box.current?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')
    first?.focus()
    const outside = (event: Event) => {
      if (box.current && event.target instanceof Node && box.current.contains(event.target)) return
      onClose()
    }
    window.addEventListener('pointerdown', outside, true)
    window.addEventListener('blur', onClose)
    const restore = back.current
    return () => {
      window.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('blur', onClose)
      if (restore instanceof HTMLElement && restore.isConnected) restore.focus()
    }
  }, [onClose])

  const onKeyDown = (event: ReactKeyboardEvent) => {
    const all = [...(box.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? [])]
    const index = all.indexOf(document.activeElement as HTMLElement)
    const move = (to: number) => all[(to + all.length) % all.length]?.focus()
    if (event.key === 'ArrowDown') move(index + 1)
    else if (event.key === 'ArrowUp') move(index - 1)
    else if (event.key === 'Home') move(0)
    else if (event.key === 'End') move(all.length - 1)
    else if (event.key === 'Escape' || event.key === 'Tab') onClose()
    else return
    event.preventDefault()
    event.stopPropagation()
  }

  return (
    <div
      ref={box}
      role="menu"
      aria-label={label}
      data-testid="context-menu"
      onKeyDown={onKeyDown}
      className="bg-popover text-popover-foreground fixed z-50 min-w-48 overflow-hidden rounded-md border p-1 text-xs shadow-md"
      style={{ left: at.x, top: at.y }}
    >
      {items.map((item) => (
        <div key={item.command}>
          {item.separated ? <div role="separator" className="bg-border -mx-1 my-1 h-px" /> : null}
          <div
            role="menuitem"
            tabIndex={-1}
            aria-disabled={item.disabled ? 'true' : undefined}
            title={item.disabled ?? undefined}
            data-command={item.command}
            className={cn(
              'flex cursor-default select-none items-center gap-4 rounded-sm px-2 py-1 outline-none',
              item.disabled ? 'opacity-50' : 'focus:bg-accent focus:text-accent-foreground hover:bg-accent hover:text-accent-foreground',
            )}
            onClick={() => {
              if (item.disabled) return
              onClose()
              onRun(item.command)
            }}
            onKeyDown={(event) => {
              if ((event.key === 'Enter' || event.key === ' ') && !item.disabled) {
                event.preventDefault()
                onClose()
                onRun(item.command)
              }
            }}
          >
            <span className="flex-1">{item.label}</span>
            {item.shortcut ? <span className="text-muted-foreground font-mono text-[0.65rem]">{item.shortcut}</span> : null}
          </div>
        </div>
      ))}
    </div>
  )
}
