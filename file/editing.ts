import { withheld } from './withheld.ts'
import { MAX_BYTES, MAX_PATH, parseToken } from './shape.ts'

/**
 * What the Editor's page has open, per project, as the page last said it — the one
 * thing the agent door can tell an agent that its own file reader cannot: which
 * file the PERSON is editing, and whether they have changes they have not saved.
 *
 * In memory only, for as long as this process lives: it is a report of a page
 * that is open now, and yesterday's report would be a claim about a screen
 * nobody is looking at. Bounded: at most `MAX_PROJECTS` projects, oldest
 * forgotten first.
 */
export interface Editing {
  /** Project-relative path, or null when nothing is open. */
  relative: string | null
  dirty: boolean
  version: string | null
  readOnly: string | null
  /** The page said agents may not read it (an `.env`, or a link to one). */
  hidden: boolean
  /** What is in the editor, kept only while it differs from the disk. */
  text: string | null
  /** When the page said it. */
  at: string
}

const MAX_PROJECTS = 32
const reports = new Map<string, Editing>()

/** Keep what the page said, after bounding every field. Returns a refusal sentence or null. */
export function report(root: string, body: Record<string, unknown>): string | null {
  const relative = typeof body.relative === 'string' && body.relative.length <= MAX_PATH ? body.relative : null
  const dirty = body.dirty === true
  const text = dirty && typeof body.text === 'string' ? body.text : null
  if (text !== null && Buffer.byteLength(text, 'utf8') > MAX_BYTES) return 'That is more text than this app keeps.'
  const readOnly = typeof body.readOnly === 'string' ? body.readOnly.slice(0, 500) : null
  reports.delete(root)
  reports.set(root, { relative, dirty, version: parseToken(body.version), readOnly, hidden: body.hidden === true, text, at: new Date().toISOString() })
  while (reports.size > MAX_PROJECTS) reports.delete(reports.keys().next().value as string)
  return null
}

/** What the page last said for a project, or null. */
export function editingIn(root: string): Editing | null {
  return reports.get(root) ?? null
}

/** For tests. */
export function forgetEditing(): void {
  reports.clear()
}

/**
 * The agent's answer: read-only, and never the name or contents of a file agents
 * may not read (an `.env` the person opened is "a file agents may not read").
 */
export function describe(editing: Editing | null, withText: boolean): string {
  if (!editing || !editing.relative) {
    return 'The Editor has no file open in this project. It opens the file the canvas points at.'
  }
  if (editing.hidden || withheld(editing.relative)) {
    return 'The person has a file open in the Editor that agents may not read, so nothing about it is said here.'
  }
  const lines = [
    `The Editor has ${editing.relative} open${editing.readOnly ? ', read-only' : ''}.`,
    editing.dirty
      ? 'It has changes the person has not saved. What is on disk is not what they see; they save explicitly.'
      : 'Everything in it is saved: what is on disk is what they see.',
  ]
  if (editing.readOnly) lines.push(`Why it is read-only: ${editing.readOnly}`)
  if (editing.dirty && withText && editing.text !== null) {
    const shown = editing.text.split('\n')
    const width = String(shown.length).length
    lines.push('', 'What is in the editor now (unsaved):', '', ...shown.map((line, i) => `${String(i + 1).padStart(width)} ${line}`))
  } else if (editing.dirty && !withText) {
    lines.push('Call again with text: true to read the unsaved text.')
  }
  lines.push('', 'This door only reads. To change the file, use your own tools; to save the person’s edits, ask them to.')
  return lines.join('\n')
}
