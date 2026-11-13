import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react'

import { Button } from '@/components/ui/button'

/**
 * "Do you want to save the changes you made to a.ts?" — asked when a tab with unsaved changes is
 * closed, with VS Code's three answers. Save saves and closes (and does not close when the save is
 * refused); Don't save throws the changes away and closes; Cancel, Escape or a press outside keeps
 * the tab. An alert dialog: focus starts on Save and stays inside it.
 */
export function ClosePrompt({
  names,
  canSave,
  onSave,
  onDiscard,
  onCancel,
}: {
  /** The files with unsaved changes this close would take away. */
  names: string[]
  /** A sentence when they cannot be saved here (read-only), which hides Save. */
  canSave: boolean
  onSave(): void
  onDiscard(): void
  onCancel(): void
}) {
  const box = useRef<HTMLDivElement | null>(null)
  const first = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    first.current?.focus()
  }, [])
  const many = names.length > 1
  const keys = (event: ReactKeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onCancel()
      return
    }
    if (event.key !== 'Tab') return
    const all = [...(box.current?.querySelectorAll<HTMLElement>('button') ?? [])]
    const at = all.indexOf(document.activeElement as HTMLElement)
    const next = event.shiftKey ? (at - 1 + all.length) % all.length : (at + 1) % all.length
    all[next]?.focus()
    event.preventDefault()
  }
  return (
    <div className="absolute inset-0 z-50 flex items-start justify-center bg-black/20 p-4" onMouseDown={(event) => event.target === event.currentTarget && onCancel()}>
      <div
        ref={box}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="close-prompt-title"
        aria-describedby="close-prompt-body"
        data-testid="close-prompt"
        onKeyDown={keys}
        className="bg-popover text-popover-foreground mt-8 w-full max-w-sm rounded-md border p-3 text-xs shadow-lg"
      >
        <p id="close-prompt-title" className="font-medium">
          {many ? `Save the changes you made to ${names.length} files?` : `Save the changes you made to ${names[0]}?`}
        </p>
        <p id="close-prompt-body" className="text-muted-foreground mt-1">
          {many ? `${names.join(', ')}. ` : ''}Your changes are lost if you don’t save them.
        </p>
        <div className="mt-3 flex justify-end gap-2">
          {canSave ? (
            <Button ref={first} size="sm" className="h-6 px-2 text-xs" onClick={onSave} data-testid="prompt-save">
              {many ? 'Save all' : 'Save'}
            </Button>
          ) : null}
          <Button ref={canSave ? undefined : first} size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={onDiscard} data-testid="prompt-discard">
            Don’t save
          </Button>
          <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={onCancel} data-testid="prompt-cancel">
            Cancel
          </Button>
        </div>
      </div>
    </div>
  )
}
