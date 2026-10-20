import { Pencil, Plus, X } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'

/**
 * The row grammar every header menu shares — the host's project, epic and
 * kehikko menus, and a module's own (decks, papers, …): a list with a check on
 * what is open, renamed by a pencil or F2, removed by an X in two presses, and
 * made by an item at the end. Copied from the host's `canvas/Menu.tsx` so a
 * module's menus behave like the host's. `src/switcher.tsx` shows them in use.
 */

/**
 * A row's remove, in two presses: the first arms it and the X becomes the
 * question, the second does it. Armed rather than `confirm()`, which a framed
 * page cannot use. One armed row per menu; the row's `onSelect` must ignore a
 * press while armed (`armedSelect`). Disabled draws it flat with `why` as its
 * tooltip, rather than hiding it.
 */
export function Remove({
  armed,
  label,
  question,
  disabled = false,
  why,
  onArm,
  onConfirm,
}: {
  armed: boolean
  label: string
  question: string
  disabled?: boolean
  why?: string
  onArm(): void
  onConfirm(): void
}) {
  if (armed) {
    return (
      <button
        type="button"
        className="text-destructive shrink-0 text-[10px] font-medium"
        onClick={(event) => {
          event.stopPropagation()
          onConfirm()
        }}
      >
        {question}
      </button>
    )
  }
  return (
    <button
      type="button"
      aria-label={disabled && why ? why : label}
      title={why}
      disabled={disabled}
      className="text-muted-foreground hover:text-destructive disabled:hover:text-muted-foreground shrink-0 disabled:opacity-40"
      onClick={(event) => {
        event.stopPropagation()
        onArm()
      }}
    >
      <X className="size-3" />
    </button>
  )
}

/** A row's `onSelect` that does nothing while its remove is armed, and disarms otherwise. */
export function armedSelect(armed: boolean, disarm: () => void, select: () => void) {
  return (event: Event) => {
    if (armed) {
      event.preventDefault()
      return
    }
    disarm()
    select()
  }
}

/**
 * F2 starts a rename. The pencil is not reachable by keyboard inside a menu
 * (Tab dismisses, arrows move between items). The row needs `group/row`.
 */
export function renameKey(start: () => void) {
  return (event: React.KeyboardEvent) => {
    if (event.key !== 'F2') return
    event.preventDefault()
    start()
  }
}

/**
 * The pencil on a row, shown on hover or focus. A span, not a button, inside
 * the item; the CLICK is stopped so renaming does not also pick the row. Its
 * pointerdown must NOT be stopped: Radix would then synthesise a click on the
 * item on pointerup, picking the row and closing the menu.
 */
export function RowPencil({ label, title, onStart }: { label: string; title: string; onStart(): void }) {
  return (
    <span
      role="button"
      tabIndex={-1}
      aria-label={label}
      title={title}
      className="text-muted-foreground hover:text-foreground pointer-events-auto shrink-0 opacity-0 group-hover/row:opacity-100 group-focus/row:opacity-100"
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onStart()
      }}
    >
      <Pencil className="size-3" />
    </span>
  )
}

/** The "new …" item at the end of the list. `keepOpen` for a form that takes the list's place. */
export function AddItem({
  icon,
  children,
  keepOpen = false,
  onAdd,
}: {
  icon?: ReactNode
  children: ReactNode
  keepOpen?: boolean
  onAdd(): void
}) {
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        onSelect={(event) => {
          if (keepOpen) event.preventDefault()
          onAdd()
        }}
      >
        {icon ?? <Plus className="text-muted-foreground size-3 shrink-0" />}
        <span className="flex-1">{children}</span>
      </DropdownMenuItem>
    </>
  )
}

/**
 * A one-field name form, drawn in place of the list (a row that turned into a
 * field loses focus when the pointer drifts). Keys stop here: Enter saves,
 * Escape abandons. `onSave` answers whether it was written; a refusal leaves
 * the form standing with the typed name.
 */
export function NameForm({
  heading,
  initial,
  label,
  placeholder,
  maxLength,
  note,
  onSave,
  onDone,
}: {
  heading: string
  initial: string
  label: string
  placeholder?: string
  maxLength: number
  note?: ReactNode
  onSave(name: string): Promise<boolean> | boolean
  onDone(): void
}) {
  const [draft, setDraft] = useState(initial)
  const [saving, setSaving] = useState(false)
  const field = useRef<HTMLInputElement>(null)

  /* Focused and selected on the way in: the form replaced a list the person had reached. */
  useEffect(() => {
    field.current?.focus()
    field.current?.select()
  }, [])

  const commit = async () => {
    const name = draft.trim()
    if (!name || name === initial) {
      onDone()
      return
    }
    setSaving(true)
    const written = await onSave(name)
    setSaving(false)
    if (written) onDone()
  }

  return (
    <div
      className="px-2 py-1.5"
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === 'Enter') void commit()
        if (event.key === 'Escape') onDone()
      }}
    >
      <p className="text-muted-foreground pb-1.5 text-xs font-medium">{heading}</p>
      <Input
        ref={field}
        value={draft}
        disabled={saving}
        onChange={(event) => setDraft(event.target.value)}
        aria-label={label}
        placeholder={placeholder}
        spellCheck={false}
        maxLength={maxLength}
        className="h-7 w-full text-xs"
      />
      {note ? <p className="text-muted-foreground pt-1.5 text-[11px] leading-snug">{note}</p> : null}
      <div className="flex justify-end gap-1 pt-2">
        <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={onDone}>
          cancel
        </Button>
        <Button size="sm" className="h-6 px-2 text-xs" disabled={saving} onClick={() => void commit()}>
          {saving ? 'saving…' : 'save'}
        </Button>
      </div>
    </div>
  )
}
