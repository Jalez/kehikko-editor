import { LIMITS, headerItemsSchema, type HeaderItem } from 'kehikot-module-protocol'

import { dirty, saveRefusal, type EditorState } from './state.ts'

/**
 * What the Editor puts in its container's header, as a pure function of its state.
 *
 *  - **Run**: Save (pinned, ⌘S), Reload from disk, Revert unsaved changes. None of
 *    them is marked for agents: an agent pressing Save would be an agent writing
 *    a file through the person's editor, which is exactly what the agent door
 *    refuses. Reload and Revert throw unsaved work away, so they ask first.
 *  - **Go**: Recent files, which opens one here (a press, not a passage: the
 *    Editor never points the canvas).
 *  - **View**: Wrap lines.
 *
 * The host draws them and relays presses; the page owns every bit of state and
 * declares the whole list again whenever any of it changes.
 */

export const RECENT_PREFIX = 'r'

/** A label within the protocol's bound, cut in the middle so both ends of a path stay readable. */
export function fit(text: string, max: number = LIMITS.HEADER_LABEL): string {
  if (text.length <= max) return text
  const keep = max - 1
  const front = Math.ceil(keep / 3)
  return `${text.slice(0, front)}…${text.slice(text.length - (keep - front))}`
}

function reason(text: string | null): string | null {
  return text === null ? null : text.length > LIMITS.REASON ? `${text.slice(0, LIMITS.REASON - 1)}…` : text
}

export function headerItems(state: EditorState, recent: readonly string[], wrap: boolean): HeaderItem[] {
  const open = state.file !== null
  const unsaved = dirty(state)
  const items: unknown[] = [
    {
      kind: 'run',
      id: 'save',
      label: 'Save',
      icon: 'check',
      shortcut: '⌘S',
      pinned: true,
      state: state.saving ? 'busy' : 'idle',
      disabled: state.saving ? null : reason(saveRefusal(state)),
    },
    {
      kind: 'run',
      id: 'reload',
      label: unsaved ? 'Reload from disk (discard changes)' : 'Reload from disk',
      icon: 'refresh',
      confirm: unsaved,
      disabled: open ? null : 'No file is open.',
    },
    {
      kind: 'run',
      id: 'revert',
      label: 'Revert unsaved changes',
      icon: 'undo',
      confirm: true,
      disabled: unsaved ? null : 'There are no unsaved changes to revert.',
    },
    { kind: 'toggle', id: 'wrap', label: 'Wrap lines', checked: wrap },
  ]
  if (recent.length) {
    items.push({
      kind: 'go',
      id: 'recent',
      label: 'Recent files',
      options: recent.map((relative, index) => ({ id: `${RECENT_PREFIX}${index}`, label: fit(relative) })),
    })
  }
  return headerItemsSchema.parse(items)
}

/** The recent file a `recent` press names, or null. */
export function recentPressed(recent: readonly string[], value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith(RECENT_PREFIX)) return null
  const index = Number(value.slice(RECENT_PREFIX.length))
  return Number.isInteger(index) ? (recent[index] ?? null) : null
}
