/**
 * The editor's state, as a pure reducer: what is open, what the edit started
 * from, what is in the editor now, and what the disk is doing.
 *
 * Every rule about "unsaved" and "changed on disk" is here and nowhere else, so
 * it can be tested without CodeMirror or a server.
 *
 *  - `saved` is the text the edit is measured against: what was on disk at
 *    `base`. **Dirty** is `text !== saved`, nothing more — typing a character
 *    and deleting it again is not a change.
 *  - `base` is the version the edit started from, and what a save sends.
 *  - `disk` is what the watch last saw: the same version, a different one, or no
 *    file at all.
 */

/** The file as the server opened it. The page's copy of `Opened` in `file/shape.ts`. */
export interface OpenedFile {
  path: string
  relative: string
  text: string
  version: string
  eol: '\n' | '\r\n'
  language: string | null
  readOnly: string | null
  hidden: boolean
}

/** A draft kept for a file: what was in the editor, and the version it was edited from. */
export interface Draft {
  version: string
  text: string
}

export interface EditorState {
  file: OpenedFile | null
  /** The version the edit started from. */
  base: string | null
  /** The text at `base`, when this page knows it; for a restored draft, the disk text it was opened against. */
  saved: string
  /** What is in the editor. */
  text: string
  disk: { state: 'same' } | { state: 'changed'; version: string } | { state: 'gone'; said: string }
  /** What the disk had when a save was refused because it changed, for a comparison. */
  conflict: { version: string; text: string | null } | null
  saving: boolean
  /** One line for the person: what just happened. */
  said: string | null
  /** A sentence when something went wrong. */
  trouble: string | null
}

export const EMPTY: EditorState = {
  file: null,
  base: null,
  saved: '',
  text: '',
  disk: { state: 'same' },
  conflict: null,
  saving: false,
  said: null,
  trouble: null,
}

export type Action =
  /** A file arrived from the server, with the draft kept for it when there is one. */
  | { type: 'opened'; file: OpenedFile; draft?: Draft | null; said?: string | null }
  | { type: 'edited'; text: string }
  | { type: 'saving' }
  /** The server saved `text` (what was sent) at `version`. */
  | { type: 'saved'; text: string; version: string; unchanged: boolean }
  | { type: 'conflict'; version: string; text: string | null; said: string | null }
  | { type: 'refused'; said: string }
  /** What the watch saw: a version, or a sentence when the file is gone. */
  | { type: 'stamp'; version: string | null; gone?: string }
  /** Throw the unsaved changes away: back to the text the edit started from. */
  | { type: 'revert' }
  | { type: 'closed'; said?: string | null }
  | { type: 'trouble'; said: string }

export function dirty(state: EditorState): boolean {
  return state.file !== null && state.text !== state.saved
}

/** Whether a save can be asked for now, or the sentence why not. */
export function saveRefusal(state: EditorState): string | null {
  if (!state.file) return 'No file is open.'
  if (state.file.readOnly) return state.file.readOnly
  if (state.saving) return 'Saving…'
  if (!dirty(state)) return 'Nothing to save: there are no unsaved changes.'
  return null
}

export function reduce(state: EditorState, action: Action): EditorState {
  switch (action.type) {
    case 'opened': {
      const { file, draft } = action
      /* A draft for a read-only file is not restored: it could never be saved. */
      const restoring = draft && !file.readOnly && draft.text !== file.text ? draft : null
      const changed = restoring !== null && restoring.version !== file.version
      return {
        ...EMPTY,
        file,
        base: restoring ? restoring.version : file.version,
        saved: file.text,
        text: restoring ? restoring.text : file.text,
        disk: changed ? { state: 'changed', version: file.version } : { state: 'same' },
        said: action.said ?? (restoring ? (changed ? 'Your unsaved changes are back, but the file changed on disk since you made them.' : 'Your unsaved changes are back.') : null),
      }
    }
    case 'edited':
      return { ...state, text: action.text, said: null }
    case 'saving':
      return { ...state, saving: true, said: null, trouble: null }
    case 'saved': {
      if (!state.file) return { ...state, saving: false }
      const file = { ...state.file, text: action.text, version: action.version }
      return {
        ...state,
        file,
        base: action.version,
        saved: action.text,
        disk: { state: 'same' },
        conflict: null,
        saving: false,
        said: action.unchanged ? 'Nothing had changed; the file is as it was.' : 'Saved.',
        trouble: null,
      }
    }
    case 'conflict':
      return {
        ...state,
        saving: false,
        disk: { state: 'changed', version: action.version },
        conflict: { version: action.version, text: action.text },
        trouble: action.said ?? state.trouble,
      }
    case 'refused':
      return { ...state, saving: false, trouble: action.said }
    case 'stamp': {
      if (!state.file) return state
      if (action.version === null) return { ...state, disk: { state: 'gone', said: action.gone ?? 'The file is no longer there.' } }
      if (action.version === state.base) return state.disk.state === 'same' ? state : { ...state, disk: { state: 'same' } }
      return state.disk.state === 'changed' && state.disk.version === action.version ? state : { ...state, disk: { state: 'changed', version: action.version } }
    }
    case 'revert':
      if (!state.file) return state
      /* Back to what was on disk when the file was opened (or last saved); the watch says if that moved since. */
      return {
        ...state,
        text: state.saved,
        base: state.file.version,
        disk: { state: 'same' },
        conflict: null,
        said: 'Your unsaved changes were thrown away.',
        trouble: null,
      }
    case 'closed':
      return { ...EMPTY, said: action.said ?? null }
    case 'trouble':
      return { ...EMPTY, trouble: action.said }
  }
}
