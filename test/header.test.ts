import { describe, expect, test } from 'bun:test'

import { headerItems, recentPressed } from '../src/edit/header.ts'
import { EMPTY, reduce, type OpenedFile } from '../src/edit/state.ts'

const file: OpenedFile = { path: '/p/a.ts', relative: 'a.ts', text: 'x', version: 'v1', eol: '\n', language: null, readOnly: null, hidden: false }

describe('the header', () => {
  test('Save, Reload and Revert in Run; Wrap in View; recent files in Go', () => {
    const items = headerItems(reduce(EMPTY, { type: 'opened', file }), ['a.ts', 'docs/b.md'], false)
    expect(items.map((item) => `${item.kind}:${item.id}`)).toEqual(['run:save', 'run:reload', 'run:revert', 'toggle:wrap', 'go:recent'])
  })

  test('no item is pressable by agents: an agent never saves through the Editor', () => {
    const state = reduce(reduce(EMPTY, { type: 'opened', file }), { type: 'edited', text: 'y' })
    for (const item of headerItems(state, ['a.ts'], true)) expect([item.id, item.agents]).toEqual([item.id, false])
  })

  test('Save is disabled with a reason when clean, enabled when dirty; Revert and a dirty Reload ask first', () => {
    const clean = headerItems(reduce(EMPTY, { type: 'opened', file }), [], false)
    const save = clean.find((item) => item.id === 'save')
    expect(save?.kind === 'run' && save.disabled).toContain('no unsaved changes')
    const dirty = headerItems(reduce(reduce(EMPTY, { type: 'opened', file }), { type: 'edited', text: 'y' }), [], false)
    const saveDirty = dirty.find((item) => item.id === 'save')
    expect(saveDirty?.kind === 'run' && saveDirty.disabled).toBeNull()
    const revert = dirty.find((item) => item.id === 'revert')
    expect(revert?.kind === 'run' && revert.confirm).toBe(true)
    const reload = dirty.find((item) => item.id === 'reload')
    expect(reload?.kind === 'run' && reload.confirm).toBe(true)
  })

  test('a long path is fitted to the label bound, and a press names a recent file by its place', () => {
    const long = `${'deep/'.repeat(20)}file.ts`
    const items = headerItems(EMPTY, [long], false)
    const go = items.find((item) => item.id === 'recent')
    expect(go?.kind === 'go' && go.options[0]!.label.length).toBeLessThanOrEqual(48)
    expect(recentPressed([long], 'r0')).toBe(long)
    expect(recentPressed([long], 'r5')).toBeNull()
    expect(recentPressed([long], true)).toBeNull()
  })
})
