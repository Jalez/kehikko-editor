import { describe, expect, test } from 'bun:test'

import { EMPTY, dirty, reduce, saveRefusal, type Action, type EditorState, type OpenedFile } from '../src/edit/state.ts'

const file: OpenedFile = {
  path: '/p/a.ts',
  relative: 'a.ts',
  text: 'one\n',
  version: 'v1',
  eol: '\n',
  language: 'typescript',
  readOnly: null,
  hidden: false,
}

const run = (...actions: Action[]): EditorState => actions.reduce(reduce, EMPTY)

describe('dirty state', () => {
  test('a file just opened is clean, and Save says why it has nothing to do', () => {
    const state = run({ type: 'opened', file })
    expect(dirty(state)).toBe(false)
    expect(saveRefusal(state)).toContain('no unsaved changes')
  })

  test('an edit makes it dirty; undoing it by hand makes it clean again', () => {
    const edited = run({ type: 'opened', file }, { type: 'edited', text: 'two\n' })
    expect(dirty(edited)).toBe(true)
    expect(saveRefusal(edited)).toBeNull()
    expect(dirty(reduce(edited, { type: 'edited', text: 'one\n' }))).toBe(false)
  })

  test('a save makes it clean at the new version; typing during the save stays unsaved', () => {
    const saving = run({ type: 'opened', file }, { type: 'edited', text: 'two\n' }, { type: 'saving' })
    expect(saveRefusal(saving)).toBe('Saving…')
    const saved = reduce(saving, { type: 'saved', text: 'two\n', version: 'v2', unchanged: false })
    expect(dirty(saved)).toBe(false)
    expect(saved.base).toBe('v2')
    const typedMeanwhile = reduce(reduce(saving, { type: 'edited', text: 'two!\n' }), { type: 'saved', text: 'two\n', version: 'v2', unchanged: false })
    expect(dirty(typedMeanwhile)).toBe(true)
  })

  test('a read-only file cannot be saved, and says why', () => {
    const state = run({ type: 'opened', file: { ...file, readOnly: 'Paper owns it.' } }, { type: 'edited', text: 'x' })
    expect(saveRefusal(state)).toBe('Paper owns it.')
  })

  test('revert goes back to the text the edit started from', () => {
    const state = run({ type: 'opened', file }, { type: 'edited', text: 'two\n' }, { type: 'revert' })
    expect(state.text).toBe('one\n')
    expect(dirty(state)).toBe(false)
  })
})

describe('the disk', () => {
  test('a different version on disk while clean is marked changed (the page then reloads)', () => {
    const state = run({ type: 'opened', file }, { type: 'stamp', version: 'v2' })
    expect(state.disk).toEqual({ state: 'changed', version: 'v2' })
    expect(dirty(state)).toBe(false)
  })

  test('a different version while dirty keeps the edit and says the disk changed', () => {
    const state = run({ type: 'opened', file }, { type: 'edited', text: 'mine\n' }, { type: 'stamp', version: 'v2' })
    expect(state.disk.state).toBe('changed')
    expect(state.text).toBe('mine\n')
  })

  test('a refused save keeps the edit, and holds what the disk has for a comparison', () => {
    const state = run(
      { type: 'opened', file },
      { type: 'edited', text: 'mine\n' },
      { type: 'saving' },
      { type: 'conflict', version: 'v2', text: 'theirs\n', said: 'changed on disk' },
    )
    expect(state.text).toBe('mine\n')
    expect(state.conflict).toEqual({ version: 'v2', text: 'theirs\n' })
    expect(state.trouble).toBe('changed on disk')
    expect(state.saving).toBe(false)
  })

  test('a file that is gone says so', () => {
    expect(run({ type: 'opened', file }, { type: 'stamp', version: null, gone: 'gone' }).disk).toEqual({ state: 'gone', said: 'gone' })
  })
})

describe('drafts', () => {
  test('a draft made against the version on disk comes back as unsaved changes', () => {
    const state = run({ type: 'opened', file, draft: { version: 'v1', text: 'draft\n' } })
    expect(state.text).toBe('draft\n')
    expect(dirty(state)).toBe(true)
    expect(state.disk.state).toBe('same')
  })

  test('a draft made against an older version comes back, with the disk marked changed, so a save is refused', () => {
    const state = run({ type: 'opened', file: { ...file, version: 'v2' }, draft: { version: 'v1', text: 'draft\n' } })
    expect(state.base).toBe('v1')
    expect(state.disk).toEqual({ state: 'changed', version: 'v2' })
  })

  test('a draft for a read-only file is not restored', () => {
    const state = run({ type: 'opened', file: { ...file, readOnly: 'no' }, draft: { version: 'v1', text: 'draft\n' } })
    expect(state.text).toBe('one\n')
  })
})
