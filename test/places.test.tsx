import { afterEach, describe, expect, test } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { FILE_DRAG_TYPE, type Passage } from 'kehikot-module-protocol'

import { Screen, type Host } from '../src/app.tsx'
import { COMMAND_IDS } from '../src/commands/list.ts'
import type { CodeEditorProps, EditorHandle } from '../src/view/code-editor.tsx'
import type { Api, Definition, Opened, Order, OrderDone, SearchAnswer } from '../src/wire/api.ts'

/**
 * Switching places: the tab the canvas pointed at in the place before does not pose as this place's
 * file, and the tabs the person kept stay. A host that says spaces and one that says only an epic and
 * its parts are the same.
 */

afterEach(() => {
  cleanup()
  try {
    sessionStorage.clear()
    localStorage.clear()
  } catch {
    /* none */
  }
})

const ROOT = '/work/thesis'
const passage = (path: string): Passage => ({ path, page: null, from: null, to: null, quoted: '', section: null })

function host(over: Partial<Host> = {}): Host {
  return { where: 'hosted', project: 'Thesis', projectPath: ROOT, projectId: null, passage: null, header: () => {}, ...over }
}

/** What the stand-in editor was last given, per tab. */
const seen: { reveal: CodeEditorProps['reveal']; tab?: string }[] = []
let handle: EditorHandle | null = null

/** CodeMirror does not lay out without a layout engine; a textarea stands in, with the same props. */
function Plain(props: CodeEditorProps) {
  const { tab, text, generation, readOnly, onChange, reveal, onRevealed, onHandle, onFocusChange } = props
  seen.push({ reveal, tab })
  if (reveal) queueMicrotask(() => onRevealed?.())
  onHandle?.(handle)
  return (
    <textarea
      key={`${tab}:${generation}`}
      aria-label="code"
      defaultValue={text}
      readOnly={readOnly}
      onFocus={() => onFocusChange?.(true)}
      onChange={(event) => onChange(event.target.value)}
    />
  )
}

function fakeApi(files: Record<string, string>, more: Partial<Api> = {}) {
  const done: { id: string; done: OrderDone }[] = []
  let orderSink: ((orders: Order[]) => void) | null = null
  const saves: string[] = []
  const api: Api = {
    changes: (_p, _path, onChange) => (onChange(), () => {}),
    async open(_p, path) {
      const relative = path.replace(`${ROOT}/`, '')
      if (!(relative in files)) return { ok: false, kind: 'refused', status: 404, error: 'That file is not somewhere this app can look.', body: null }
      const body: Opened = { root: ROOT, path, relative, text: files[relative]!, version: 'v1', eol: '\n', language: null, readOnly: null, hidden: false }
      return { ok: true, status: 200, body }
    },
    async stamp() {
      return null
    },
    async save(_p, path) {
      saves.push(path)
      return { kind: 'saved', version: 'v2', unchanged: false }
    },
    async editing() {},
    orders: (_p, sink) => ((orderSink = sink), () => (orderSink = null)),
    heldOrders: async () => [],
    ordersDone: async (id, body) => void done.push({ id, done: body }),
    ...more,
  }
  return { api, done, saves, order: (order: Order) => act(() => orderSink?.([order])) }
}

const tabs = () => screen.queryAllByTestId('tab')
const names = () => tabs().map((tab) => within(tab).getByTestId('tab-name').textContent)
const activeName = () => tabs().find((tab) => tab.getAttribute('aria-selected') === 'true')?.querySelector('[data-testid="tab-name"]')?.textContent
import { placeKey } from '../src/edit/place.ts'
import { NO_TABS, reduceTabs, type TabsState } from '../src/edit/tabs.ts'

describe('a place', () => {
  test('a host that says spaces and one that says epic and parts name the same place', () => {
    const said = (...ids: string[]) => ({ space: { path: ids.map((id) => ({ id })), picked: [] as string[] } })
    expect(placeKey(said('a'))).toBe(placeKey({ epic: 'a', parts: [] }))
    expect(placeKey(said('a', 'p'))).toBe(placeKey({ epic: 'a', parts: ['p'] }))
    expect(placeKey({ epic: 'a', parts: ['q', 'p'] })).toBe(placeKey({ epic: 'a', space: { path: [{ id: 'a' }], picked: ['p', 'q'] } }))
    expect(placeKey({})).toBe('project')
    expect(placeKey(said('a', 'b', 'c'))).not.toBe(placeKey(said('a', 'b')))
  })

  test('leaving closes only what the canvas pointed at and the person did not keep', () => {
    const open = (state: TabsState, id: string, over: object) => reduceTabs(state, { type: 'open', id, path: `/r/${id}.ts`, preview: true, focus: true, ...over })
    let state = open(NO_TABS, 'kept', { preview: false })
    state = open(state, 'pointed', { pointed: true })
    expect(state.tabs.map((tab) => tab.id)).toEqual(['kept', 'pointed'])
    expect(reduceTabs(state, { type: 'leave' }).tabs.map((tab) => tab.id)).toEqual(['kept'])
    expect(reduceTabs(state, { type: 'leave' }).active).toBe('kept')
    /* Kept by a double-click: no longer a preview, so it stays. */
    const pinned = reduceTabs(state, { type: 'pin', id: 'pointed' })
    expect(reduceTabs(pinned, { type: 'leave' }).tabs.map((tab) => tab.id)).toEqual(['kept', 'pointed'])
    /* A preview the canvas did not point at (a search result) is not the old place's. */
    const searched = open(open(NO_TABS, 'kept', { preview: false }), 'found', {})
    expect(reduceTabs(searched, { type: 'leave' }).tabs.map((tab) => tab.id)).toEqual(['kept', 'found'])
  })
})

const space = (...ids: string[]): Partial<Host> => ({ epic: ids[0] ?? null, context: { space: { path: ids.map((id) => ({ id })), picked: [] } } as never })
/** An older host: only the epic and the parts picked out. */
const older = (epic: string | null, ...parts: string[]): Partial<Host> => ({ epic, parts: parts.map((id) => ({ id, heading: id, refs: [], picked: true })) as never })

describe.each([
  ['a host that says spaces', (n: number) => space('thesis', ...['one', 'two', 'three'].slice(0, n))],
  ['an older host, with epic and parts only', (n: number) => (n === 0 ? older('thesis') : older('thesis', ['one', 'two', 'three'][n - 1]!))],
] as const)('switching places on %s', (_name, at) => {
  const draw = (api: Api, first: Partial<Host>) => {
    const view = render(<Screen host={host(first)} api={api} Code={Plain} />)
    return (over: Partial<Host>) => view.rerender(<Screen host={host(over)} api={api} Code={Plain} />)
  }

  test('a place that points at nothing shows nothing of the place before, and back again restores it', async () => {
    const { api } = fakeApi({ 'a.ts': 'a\n' })
    const go = draw(api, { ...at(1), passage: passage(`${ROOT}/a.ts`) })
    await waitFor(() => expect(names()).toEqual(['a.ts']))
    await waitFor(() => screen.getByLabelText('code'))

    go({ ...at(2), passage: null })
    await waitFor(() => expect(tabs()).toHaveLength(0))
    expect(screen.queryByLabelText('code')).toBeNull()
    expect(screen.getByTestId('nothing').textContent).toContain('No file is open here')

    go({ ...at(1), passage: passage(`${ROOT}/a.ts`) })
    await waitFor(() => expect(names()).toEqual(['a.ts']))
    await waitFor(() => expect((screen.getByLabelText('code') as HTMLTextAreaElement).value).toBe('a\n'))
  })

  test('the tabs the person kept stay; only the old place’s preview goes', async () => {
    const { api } = fakeApi({ 'a.ts': 'a\n', 'b.ts': 'b\n' })
    const go = draw(api, { ...at(1), passage: passage(`${ROOT}/a.ts`) })
    await waitFor(() => expect(names()).toEqual(['a.ts']))
    fireEvent.doubleClick(tabs()[0]!)
    go({ ...at(1), passage: passage(`${ROOT}/b.ts`) })
    await waitFor(() => expect(names()).toEqual(['a.ts', 'b.ts']))

    go({ ...at(2), passage: null })
    await waitFor(() => expect(names()).toEqual(['a.ts']))
    expect(activeName()).toBe('a.ts')

    go({ ...at(1), passage: passage(`${ROOT}/b.ts`) })
    await waitFor(() => expect(names()).toEqual(['a.ts', 'b.ts']))
  })

  test('a place that points somewhere opens it, in the old preview’s place', async () => {
    const { api } = fakeApi({ 'a.ts': 'a\n', 'b.ts': 'b\n' })
    const go = draw(api, { ...at(1), passage: passage(`${ROOT}/a.ts`) })
    await waitFor(() => expect(names()).toEqual(['a.ts']))
    go({ ...at(2), passage: passage(`${ROOT}/b.ts`) })
    await waitFor(() => expect(names()).toEqual(['b.ts']))
  })

  test('the canvas pointing at nothing within the same place is not a switch: the tab stays', async () => {
    const { api } = fakeApi({ 'a.ts': 'a\n' })
    const go = draw(api, { ...at(1), passage: passage(`${ROOT}/a.ts`) })
    await waitFor(() => expect(names()).toEqual(['a.ts']))
    go({ ...at(1), passage: null })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(names()).toEqual(['a.ts'])
  })
})
