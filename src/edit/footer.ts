import { LIMITS, footerItemsSchema, type FooterItem } from 'kehikot-module-protocol'

import { dirty, type EditorState } from './state.ts'

/**
 * What the Editor puts in its container's footer (`kehikot.footer`, protocol 2.38.0), as a pure
 * function of its state: what is going on with the open file now, so a container folded to its
 * header and footer still says which file it is and whether it is saved.
 *
 * It is the bar the page drew along the top (the file's name, unsaved, private, read-only) and the
 * one-line notices under it (why it is read-only, what just happened, what went wrong), in one row
 * the host draws. The header keeps the acts on the file (Save, Reload, Revert), Wrap lines and
 * Recent files; the notices that offer a choice (changed on disk: Compare or Reload; the canvas
 * points elsewhere: Open it) stay on the page, beside their buttons. Nothing here is pressable.
 */
const cut = (text: string, most: number) => (text.length > most ? `${text.slice(0, most - 1)}…` : text)

export function footerItems(state: EditorState, tabs: { tabs: number; unsaved: number } = { tabs: 0, unsaved: 0 }): FooterItem[] {
  const file = state.file
  if (!file) {
    const none: unknown[] = [{ kind: 'text', id: 'file', text: 'No file open' }]
    if (state.trouble) none.push({ kind: 'text', id: 'trouble', text: cut(state.trouble, LIMITS.FOOTER_TEXT), level: 'critical', align: 'center', tooltip: cut(state.trouble, LIMITS.FOOTER_TOOLTIP) })
    else if (state.said) none.push({ kind: 'text', id: 'said', text: cut(state.said, LIMITS.FOOTER_TEXT), align: 'center', optional: true })
    return footerItemsSchema.parse(none)
  }
  const unsaved = dirty(state)
  const items: unknown[] = [{ kind: 'text', id: 'file', text: cut(file.relative, LIMITS.FOOTER_TEXT), tooltip: cut(file.path, LIMITS.FOOTER_TOOLTIP) }]
  const status =
    state.disk.state === 'gone'
      ? { text: 'Gone from disk', level: 'critical', tooltip: state.disk.said }
      : state.disk.state === 'changed' && unsaved
        ? { text: 'Changed on disk', level: 'critical', tooltip: 'This file changed on disk since you started editing it. Saving is refused until you choose.' }
        : state.saving
          ? { text: 'Saving…', level: 'normal' }
          : unsaved
            ? { text: 'Unsaved', level: 'warn', tooltip: 'This file has changes that are not saved.' }
            : { text: 'Saved', level: 'normal' }
  items.push({ kind: 'text', id: 'status', ...status, ...(status.tooltip ? { tooltip: cut(status.tooltip, LIMITS.FOOTER_TOOLTIP) } : {}) })
  if (file.readOnly) items.push({ kind: 'text', id: 'read-only', text: 'read-only', tooltip: cut(file.readOnly, LIMITS.FOOTER_TOOLTIP) })
  if (file.hidden) items.push({ kind: 'text', id: 'private', text: 'private', tooltip: 'Agents cannot read this file.', optional: true })
  const changedShown = state.disk.state === 'changed' && unsaved
  if (state.trouble && !changedShown) items.push({ kind: 'text', id: 'trouble', text: cut(state.trouble, LIMITS.FOOTER_TEXT), level: 'critical', align: 'center', tooltip: cut(state.trouble, LIMITS.FOOTER_TOOLTIP) })
  else if (state.said) items.push({ kind: 'text', id: 'said', text: cut(state.said, LIMITS.FOOTER_TEXT), align: 'center', optional: true })
  if (tabs.tabs > 1) {
    const words = `${tabs.tabs} tabs${tabs.unsaved ? `, ${tabs.unsaved} unsaved` : ''}`
    items.push({ kind: 'text', id: 'tabs', text: words, align: 'end', optional: true, ...(tabs.unsaved ? { level: 'warn' } : {}) })
  }
  if (file.language) items.push({ kind: 'text', id: 'language', text: cut(file.language, LIMITS.FOOTER_TEXT), align: 'end', optional: true })
  return footerItemsSchema.parse(items)
}
