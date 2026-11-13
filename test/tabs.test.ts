import { describe, expect, test } from 'bun:test'

import type { OpenedFile } from '../src/edit/state.ts'
import { KEPT_TABS_CHARS, NO_TABS, activeTab, keptOf, readKept, reduceTabs, tabDirty, tabLabels, type TabsAction, type TabsState } from '../src/edit/tabs.ts'

const file = (relative: string, over: Partial<OpenedFile> = {}): OpenedFile => ({
  path: `/p/${relative}`,
  relative,
  text: 'x\n',
  version: 'v1',
  eol: '\n',
  language: null,
  readOnly: null,
  hidden: false,
  ...over,
})

let n = 0
const open = (relative: string, over: Partial<Extract<TabsAction, { type: 'open' }>> = {}): TabsAction => ({
  type: 'open',
  id: `t${++n}`,
  path: `/p/${relative}`,
  preview: false,
  focus: true,
  ...over,
})
const run = (actions: TabsAction[], from: TabsState = NO_TABS) => actions.reduce(reduceTabs, from)
const names = (state: TabsState) => state.tabs.map((tab) => tab.path.replace('/p/', ''))
const idOf = (state: TabsState, relative: string) => state.tabs.find((tab) => tab.path === `/p/${relative}`)!.id

describe('tabs', () => {
  test('a new tab opens to the right of the active one and becomes active', () => {
    let state = run([open('a'), open('b'), open('c')])
    state = reduceTabs(state, { type: 'activate', id: idOf(state, 'a'), by: 'person' })
    state = reduceTabs(state, open('d'))
    expect(names(state)).toEqual(['a', 'd', 'b', 'c'])
    expect(activeTab(state)!.path).toBe('/p/d')
  })

  test('opening a file that has a tab focuses it, never a second tab', () => {
    const state = run([open('a'), open('b'), open('a')])
    expect(names(state)).toEqual(['a', 'b'])
    expect(activeTab(state)!.path).toBe('/p/a')
  })

  test('a preview is replaced by the next preview, in place', () => {
    const state = run([open('a'), open('b', { preview: true }), open('c', { preview: true })])
    expect(names(state)).toEqual(['a', 'c'])
    expect(state.tabs[1]!.preview).toBe(true)
  })

  test('an edit keeps a preview, so the next preview opens beside it and nothing is discarded', () => {
    let state = run([open('b', { preview: true })])
    const id = idOf(state, 'b')
    state = reduceTabs(state, { type: 'opened', id, file: file('b') })
    state = reduceTabs(state, { type: 'file', id, action: { type: 'edited', text: 'changed\n' } })
    expect(state.tabs[0]!.preview).toBe(false)
    expect(tabDirty(state.tabs[0]!)).toBe(true)
    state = reduceTabs(state, open('c', { preview: true }))
    expect(names(state)).toEqual(['b', 'c'])
    expect(state.tabs[0]!.state.text).toBe('changed\n')
  })

  test('double-clicking a preview (pin) keeps it', () => {
    let state = run([open('b', { preview: true })])
    state = reduceTabs(state, { type: 'pin', id: idOf(state, 'b') })
    state = reduceTabs(state, open('c', { preview: true }))
    expect(names(state)).toEqual(['b', 'c'])
  })

  test('opening a preview of a file kept open does not make it a preview again', () => {
    const state = run([open('a'), open('a', { preview: true })])
    expect(state.tabs[0]!.preview).toBe(false)
  })

  test('closing the active tab activates the one used most recently before it', () => {
    let state = run([open('a'), open('b'), open('c')])
    state = reduceTabs(state, { type: 'activate', id: idOf(state, 'a'), by: 'person' })
    state = reduceTabs(state, { type: 'activate', id: idOf(state, 'c'), by: 'person' })
    state = reduceTabs(state, { type: 'close', ids: [idOf(state, 'c')] })
    expect(activeTab(state)!.path).toBe('/p/a')
  })

  test('reorder: a tab moves to an index of the strip', () => {
    let state = run([open('a'), open('b'), open('c')])
    state = reduceTabs(state, { type: 'move', id: idOf(state, 'a'), to: 3 })
    expect(names(state)).toEqual(['b', 'c', 'a'])
    state = reduceTabs(state, { type: 'move', id: idOf(state, 'a'), to: 0 })
    expect(names(state)).toEqual(['a', 'b', 'c'])
  })

  test('a drop opens at the position it names', () => {
    const state = run([open('a'), open('b'), open('c', { at: 1 })])
    expect(names(state)).toEqual(['a', 'c', 'b'])
  })

  test('an agent’s tab opens in the background when it does not take focus, and is marked until touched', () => {
    let state = run([open('a')])
    state = reduceTabs(state, open('b', { agent: true, focus: false }))
    expect(activeTab(state)!.path).toBe('/p/a')
    expect(state.tabs[1]!.agent).toBe(true)
    state = reduceTabs(state, { type: 'activate', id: idOf(state, 'b'), by: 'agent' })
    expect(state.tabs[1]!.agent).toBe(true)
    state = reduceTabs(state, { type: 'activate', id: idOf(state, 'b'), by: 'person' })
    expect(state.tabs[1]!.agent).toBe(false)
  })

  test('two spellings of one file end in one tab', () => {
    let state = run([open('a'), open('link-to-a')])
    state = reduceTabs(state, { type: 'opened', id: idOf(state, 'a'), file: file('a') })
    state = reduceTabs(state, { type: 'opened', id: idOf(state, 'link-to-a'), file: file('a') })
    expect(state.tabs).toHaveLength(1)
    expect(activeTab(state)!.relative).toBe('a')
  })
})

describe('tab labels', () => {
  test('a name alone, and the parent folder when names clash', () => {
    expect(tabLabels(['src/index.ts', 'test/index.ts', 'src/app.tsx'])).toEqual([
      { name: 'index.ts', folder: 'src' },
      { name: 'index.ts', folder: 'test' },
      { name: 'app.tsx', folder: null },
    ])
    expect(tabLabels(['a/x/index.ts', 'b/x/index.ts'])).toEqual([
      { name: 'index.ts', folder: 'a/x' },
      { name: 'index.ts', folder: 'b/x' },
    ])
  })
})

describe('what the host keeps for the container', () => {
  test('tabs, the active one and each view round-trip, within the host’s bound', () => {
    let state = run([open('a'), open('b', { preview: true })])
    for (const tab of state.tabs) state = reduceTabs(state, { type: 'opened', id: tab.id, file: file(tab.path.replace('/p/', '')) })
    state = reduceTabs(state, { type: 'view', id: idOf(state, 'a'), view: { anchor: 3, head: 5, top: 120 } })
    const kept = keptOf(state)
    expect(kept).toEqual({ tabs: [{ path: 'a', view: { anchor: 3, head: 5, top: 120 } }, { path: 'b', preview: true }], active: 'b' })
    expect(readKept(JSON.parse(JSON.stringify(kept)))).toEqual(kept)
  })

  test('many long paths are cut to fit, the active one kept', () => {
    let state: TabsState = NO_TABS
    for (let i = 0; i < 40; i += 1) state = reduceTabs(state, open(`deep/folder/name/that/is/long/file-${i}.ts`))
    for (const tab of state.tabs) state = reduceTabs(state, { type: 'opened', id: tab.id, file: file(tab.path.replace('/p/', '')) })
    const kept = keptOf(state)
    expect(JSON.stringify(kept).length).toBeLessThanOrEqual(KEPT_TABS_CHARS)
    expect(kept.tabs.some((one) => one.path === kept.active)).toBe(true)
  })

  test('a kept value that leaves the project or is malformed is dropped', () => {
    expect(readKept({ tabs: [{ path: '../etc/passwd' }, { path: '/abs' }, { path: 'ok.ts', view: { anchor: -1 } }, 7], active: 'nope' })).toEqual({ tabs: [{ path: 'ok.ts' }], active: null })
    expect(readKept('junk')).toEqual({ tabs: [], active: null })
  })
})
