import { ChevronDown } from 'lucide-react'
import { useState } from 'react'

import { AddItem, NameForm, Remove, RowPencil, armedSelect, renameKey } from '@/components/menu'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheck,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

export interface Item {
  id: string
  name: string
}

/**
 * An example header switcher in the shared menu grammar (see
 * `components/menu.tsx`): the items with a check on the open one, a pencil (or
 * F2) to rename, an X in two presses to remove, and "new …" last. Swap `Item`
 * for whatever this module keeps several of — decks, papers, lists.
 *
 * What is drawn is either the list or one name form, never both, and at most
 * one row is armed at a time.
 */
export function Switcher({
  noun,
  items,
  current,
  onPick,
  onRename,
  onRemove,
  onCreate,
}: {
  /** What one item is called: "deck". */
  noun: string
  items: Item[]
  current: string | null
  onPick(id: string): void
  onRename(id: string, name: string): boolean | Promise<boolean>
  onRemove(id: string): void
  onCreate(name: string): boolean | Promise<boolean>
}) {
  const [armed, setArmed] = useState<string | null>(null)
  const [form, setForm] = useState<{ kind: 'rename'; id: string } | { kind: 'new' } | null>(null)
  const open = items.find((one) => one.id === current) ?? null
  const renaming = form?.kind === 'rename' ? items.find((one) => one.id === form.id) : undefined

  return (
    <DropdownMenu
      onOpenChange={(isOpen) => {
        if (isOpen) return
        setArmed(null)
        setForm(null)
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 min-w-0 gap-1 px-2 text-xs">
          <span className="truncate">{open ? open.name : `no ${noun}`}</span>
          <ChevronDown className="size-3 shrink-0 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        {form ? (
          <NameForm
            heading={form.kind === 'new' ? `New ${noun}` : `Rename ${noun}`}
            initial={renaming?.name ?? ''}
            label={`${noun} name`}
            maxLength={80}
            onSave={(name) => (form.kind === 'new' ? onCreate(name) : onRename(form.id, name))}
            onDone={() => setForm(null)}
          />
        ) : (
          <>
            {items.map((one) => (
              <DropdownMenuItem
                key={one.id}
                className="group/row"
                onSelect={armedSelect(armed === one.id, () => setArmed(null), () => onPick(one.id))}
                onKeyDown={renameKey(() => setForm({ kind: 'rename', id: one.id }))}
              >
                <DropdownMenuCheck checked={one.id === current} />
                <span className="min-w-0 flex-1 truncate">{one.name}</span>
                <RowPencil
                  label={`rename ${one.name}`}
                  title="rename (F2)"
                  onStart={() => setForm({ kind: 'rename', id: one.id })}
                />
                <Remove
                  armed={armed === one.id}
                  label={`remove ${one.name}`}
                  question="remove it?"
                  onArm={() => setArmed(one.id)}
                  onConfirm={() => {
                    setArmed(null)
                    onRemove(one.id)
                  }}
                />
              </DropdownMenuItem>
            ))}
            <AddItem keepOpen onAdd={() => setForm({ kind: 'new' })}>
              new {noun}…
            </AddItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
