import { describe, expect, test } from 'bun:test'

import { footerItems } from '../src/edit/footer.ts'
import { EMPTY, type EditorState, type OpenedFile } from '../src/edit/state.ts'

const file: OpenedFile = { path: '/p/a.ts', relative: 'a.ts', text: 'x', version: 'v1', eol: '\n', language: 'TypeScript', readOnly: null, hidden: false }
const open = (over: Partial<EditorState> = {}): EditorState => ({ ...EMPTY, file, base: 'v1', saved: 'x', text: 'x', ...over })

describe('the footer', () => {
  test('no file, one line; nothing pressable anywhere', () => {
    expect(footerItems(EMPTY)).toEqual([expect.objectContaining({ kind: 'text', id: 'file', text: 'No file open' })])
    expect(footerItems(open()).every((i) => i.kind === 'text')).toBe(true)
  })

  test('saved, unsaved, saving, changed on disk, gone', () => {
    const status = (state: EditorState) => footerItems(state).find((i) => i.id === 'status')
    expect(status(open())).toMatchObject({ text: 'Saved', level: 'normal' })
    expect(status(open({ text: 'y' }))).toMatchObject({ text: 'Unsaved', level: 'warn' })
    expect(status(open({ text: 'y', saving: true }))).toMatchObject({ text: 'Saving…' })
    expect(status(open({ text: 'y', disk: { state: 'changed', version: 'v2' } }))).toMatchObject({ text: 'Changed on disk', level: 'critical' })
    expect(status(open({ disk: { state: 'gone', said: 'The file is no longer there.' } }))).toMatchObject({ text: 'Gone from disk', level: 'critical' })
  })

  test('read-only says why in its tooltip; private; trouble wins over what was said', () => {
    const items = footerItems(open({ file: { ...file, readOnly: 'Paper edits it.', hidden: true }, trouble: 'It could not be saved.', said: 'Saved.' }))
    expect(items.find((i) => i.id === 'read-only')).toMatchObject({ tooltip: 'Paper edits it.' })
    expect(items.find((i) => i.id === 'private')).toMatchObject({ optional: true })
    expect(items.find((i) => i.id === 'trouble')).toMatchObject({ level: 'critical' })
    expect(items.some((i) => i.id === 'said')).toBe(false)
  })
})
