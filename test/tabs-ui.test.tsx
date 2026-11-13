import { afterEach, describe, expect, test } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { FILE_DRAG_TYPE, type Passage } from 'kehikot-module-protocol'

import { Screen, type Host } from '../src/app.tsx'
import { COMMAND_IDS } from '../src/commands/list.ts'
import type { CodeEditorProps, EditorHandle } from '../src/view/code-editor.tsx'
import type { Api, Definition, Opened, Order, OrderDone, SearchAnswer } from '../src/wire/api.ts'

/**
 * The page with tabs, through the DOM: roles and keys, preview tabs, the close prompt, what is kept
 * for the container, drops, the palette and quick open, go to definition, search in project, and an
 * agent's orders.
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
const key = (init: KeyboardEventInit & { key: string; code?: string }) => act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })))

describe('the tab strip', () => {
  test('is a tablist of tabs, the active one selected and the only one in the tab order', async () => {
    const { api } = fakeApi({ 'a.ts': 'a\n', 'b.ts': 'b\n' })
    const { rerender } = render(<Screen host={host({ passage: passage(`${ROOT}/a.ts`) })} api={api} Code={Plain} />)
    await waitFor(() => expect(names()).toEqual(['a.ts']))
    rerender(<Screen host={host({ passage: passage(`${ROOT}/b.ts`) })} api={api} Code={Plain} />)
    /* The canvas opens a preview: the next pointing replaces it. */
    await waitFor(() => expect(names()).toEqual(['b.ts']))
    expect(screen.getByRole('tablist', { name: 'Open files' })).toBeDefined()
    const tab = tabs()[0]!
    expect(tab.getAttribute('aria-selected')).toBe('true')
    expect(tab.getAttribute('tabindex')).toBe('0')
    expect(within(tab).getByTestId('tab-name').className).toContain('italic')
  })

  test('a double-click keeps a preview; an edit keeps it too, and shows the unsaved dot in place of the close', async () => {
    const { api } = fakeApi({ 'a.ts': 'a\n', 'b.ts': 'b\n', 'c.ts': 'c\n' })
    const { rerender } = render(<Screen host={host({ passage: passage(`${ROOT}/a.ts`) })} api={api} Code={Plain} />)
    await waitFor(() => expect(names()).toEqual(['a.ts']))
    fireEvent.doubleClick(tabs()[0]!)
    rerender(<Screen host={host({ passage: passage(`${ROOT}/b.ts`) })} api={api} Code={Plain} />)
    await waitFor(() => expect(names()).toEqual(['a.ts', 'b.ts']))
    await waitFor(() => screen.getByLabelText('code'))
    fireEvent.change(screen.getByLabelText('code'), { target: { value: 'edited\n' } })
    expect(within(tabs()[1]!).getByTestId('tab-unsaved')).toBeDefined()
    expect(within(tabs()[1]!).getByTestId('tab-close').getAttribute('aria-label')).toBe('Close b.ts (unsaved)')
    rerender(<Screen host={host({ passage: passage(`${ROOT}/c.ts`) })} api={api} Code={Plain} />)
    await waitFor(() => expect(names()).toEqual(['a.ts', 'b.ts', 'c.ts']))
  })

  test('arrow keys move along the strip; a middle-click closes', async () => {
    const { api } = fakeApi({ 'a.ts': 'a\n', 'b.ts': 'b\n' })
    const { rerender } = render(<Screen host={host({ passage: passage(`${ROOT}/a.ts`) })} api={api} Code={Plain} />)
    await waitFor(() => expect(names()).toEqual(['a.ts']))
    fireEvent.doubleClick(tabs()[0]!)
    rerender(<Screen host={host({ passage: passage(`${ROOT}/b.ts`) })} api={api} Code={Plain} />)
    await waitFor(() => expect(activeName()).toBe('b.ts'))
    fireEvent.keyDown(tabs()[1]!, { key: 'ArrowLeft' })
    await waitFor(() => expect(activeName()).toBe('a.ts'))
    fireEvent.keyDown(tabs()[0]!, { key: 'End' })
    await waitFor(() => expect(activeName()).toBe('b.ts'))
    fireEvent(tabs()[1]!, new MouseEvent('auxclick', { bubbles: true, button: 1 }))
    await waitFor(() => expect(names()).toEqual(['a.ts']))
  })

  test('closing an unsaved tab asks Save / Don’t save / Cancel, and each does what it says', async () => {
    const { api, saves } = fakeApi({ 'a.ts': 'a\n' })
    render(<Screen host={host({ passage: passage(`${ROOT}/a.ts`) })} api={api} Code={Plain} />)
    await waitFor(() => screen.getByLabelText('code'))
    fireEvent.change(screen.getByLabelText('code'), { target: { value: 'edited\n' } })
    fireEvent.click(within(tabs()[0]!).getByTestId('tab-close'))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog.textContent).toContain('Save the changes you made to a.ts?')
    fireEvent.click(screen.getByTestId('prompt-cancel'))
    expect(names()).toEqual(['a.ts'])
    fireEvent.click(within(tabs()[0]!).getByTestId('tab-close'))
    fireEvent.click(await screen.findByTestId('prompt-save'))
    await waitFor(() => expect(names()).toEqual([]))
    expect(saves).toEqual([`${ROOT}/a.ts`])
  })

  test('Don’t save closes and forgets the draft', async () => {
    const { api, saves } = fakeApi({ 'a.ts': 'a\n' })
    render(<Screen host={host({ passage: passage(`${ROOT}/a.ts`) })} api={api} Code={Plain} />)
    await waitFor(() => screen.getByLabelText('code'))
    fireEvent.change(screen.getByLabelText('code'), { target: { value: 'edited\n' } })
    fireEvent.click(within(tabs()[0]!).getByTestId('tab-close'))
    fireEvent.click(await screen.findByTestId('prompt-discard'))
    await waitFor(() => expect(names()).toEqual([]))
    expect(saves).toEqual([])
  })

  test('the tab menu’s items are commands, and Close others closes the others', async () => {
    const { api } = fakeApi({ 'a.ts': 'a\n', 'b.ts': 'b\n' })
    const { rerender } = render(<Screen host={host({ passage: passage(`${ROOT}/a.ts`) })} api={api} Code={Plain} />)
    await waitFor(() => expect(names()).toEqual(['a.ts']))
    fireEvent.doubleClick(tabs()[0]!)
    rerender(<Screen host={host({ passage: passage(`${ROOT}/b.ts`) })} api={api} Code={Plain} />)
    await waitFor(() => expect(names()).toEqual(['a.ts', 'b.ts']))
    fireEvent.contextMenu(tabs()[1]!, { clientX: 10, clientY: 10 })
    const menu = await screen.findByRole('menu')
    const items = within(menu).getAllByRole('menuitem')
    expect(items.map((item) => item.querySelector('span')?.textContent)).toEqual(['Close', 'Close others', 'Close to the right', 'Close saved', 'Copy path', 'Copy relative path', 'Keep open'])
    for (const item of items) expect(COMMAND_IDS.has(item.getAttribute('data-command')!)).toBe(true)
    fireEvent.click(items[1]!)
    await waitFor(() => expect(names()).toEqual(['b.ts']))
  })
})

describe('what is kept for the container', () => {
  test('the open tabs and the active one come back from what the host kept', async () => {
    const { api } = fakeApi({ 'a.ts': 'a\n', 'src/b.ts': 'b\n' })
    const kept = { tabs: { tabs: [{ path: 'a.ts' }, { path: 'src/b.ts', view: { anchor: 1, head: 1, top: 0 } }], active: 'src/b.ts' } }
    render(<Screen host={host({ kept, read: (() => ({ kept })) as never, remember: () => {} })} api={api} Code={Plain} />)
    await waitFor(() => expect(names()).toEqual(['a.ts', 'b.ts']))
    expect(activeName()).toBe('b.ts')
    await waitFor(() => expect((screen.getByLabelText('code') as HTMLTextAreaElement).value).toBe('b\n'))
  })

  test('a change of tabs is written back for the host to keep', async () => {
    const wrote: unknown[] = []
    let kept: unknown = {}
    const { api } = fakeApi({ 'a.ts': 'a\n' })
    render(<Screen host={host({ passage: passage(`${ROOT}/a.ts`), kept, read: (() => ({ kept })) as never, remember: ((next: unknown) => { kept = next; wrote.push(next) }) as never })} api={api} Code={Plain} />)
    await waitFor(() => expect(wrote.at(-1)).toMatchObject({ tabs: { tabs: [{ path: 'a.ts', preview: true }], active: 'a.ts' } }))
  })
})

describe('drops', () => {
  const dataTransfer = (types: Record<string, string>) => ({ types: Object.keys(types), getData: (type: string) => types[type] ?? '', dropEffect: 'none' })

  test('a file of this project dropped on the page opens in a tab', async () => {
    const { api } = fakeApi({ 'src/a.ts': 'a\n' })
    render(<Screen host={host()} api={api} Code={Plain} />)
    const page = document.querySelector('[data-kehikot-page]')!
    fireEvent.drop(page, { dataTransfer: dataTransfer({ [FILE_DRAG_TYPE]: JSON.stringify({ project: ROOT, path: 'src/a.ts' }) }) })
    await waitFor(() => expect(names()).toEqual(['a.ts']))
  })

  test('a path outside the project is refused in words, and nothing opens', async () => {
    const { api } = fakeApi({ 'a.ts': 'a\n' })
    render(<Screen host={host()} api={api} Code={Plain} />)
    const page = document.querySelector('[data-kehikot-page]')!
    fireEvent.drop(page, { dataTransfer: dataTransfer({ [FILE_DRAG_TYPE]: JSON.stringify({ project: '/elsewhere', path: 'secret.txt' }), 'text/uri-list': 'file:///etc/passwd' }) })
    await waitFor(() => expect(screen.getByTestId('notice').textContent).toContain('not a file of this project'))
    expect(names()).toEqual([])
  })

  test('a drop the host hands on from another module opens too', async () => {
    const { api } = fakeApi({ 'b.ts': 'b\n' })
    const drop = { current: (_: unknown) => {} }
    render(<Screen host={host()} api={api} Code={Plain} drop={drop as never} />)
    act(() => drop.current({ file: { project: ROOT, path: 'b.ts', kind: 'file' }, at: { x: 10, y: 200 } }))
    await waitFor(() => expect(names()).toEqual(['b.ts']))
  })
})

describe('the keyboard and the palette', () => {
  test('⇧⌘P opens the palette; it lists commands with their keys and runs the one picked', async () => {
    const { api } = fakeApi({ 'a.ts': 'a\n' })
    render(<Screen host={host({ passage: passage(`${ROOT}/a.ts`) })} api={api} Code={Plain} mac />)
    await waitFor(() => expect(names()).toEqual(['a.ts']))
    key({ key: 'p', code: 'KeyP', metaKey: true, shiftKey: true })
    const box = await screen.findByRole('combobox')
    expect((box as HTMLInputElement).value).toBe('>')
    fireEvent.change(box, { target: { value: '>close tab' } })
    await waitFor(() => expect(screen.getAllByTestId('picker-item')[0]!.textContent).toContain('Close tab'))
    expect(screen.getAllByTestId('picker-item')[0]!.textContent).toContain('⌘W')
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => expect(names()).toEqual([]))
  })

  test('Ctrl+Tab goes to the tab used before; ⌘K ⌘W closes them all', async () => {
    const { api } = fakeApi({ 'a.ts': 'a\n', 'b.ts': 'b\n' })
    const { rerender } = render(<Screen host={host({ passage: passage(`${ROOT}/a.ts`) })} api={api} Code={Plain} mac />)
    await waitFor(() => expect(names()).toEqual(['a.ts']))
    fireEvent.doubleClick(tabs()[0]!)
    rerender(<Screen host={host({ passage: passage(`${ROOT}/b.ts`) })} api={api} Code={Plain} mac />)
    await waitFor(() => expect(activeName()).toBe('b.ts'))
    key({ key: 'Tab', code: 'Tab', ctrlKey: true })
    await waitFor(() => expect(activeName()).toBe('a.ts'))
    key({ key: 'k', code: 'KeyK', metaKey: true })
    key({ key: 'w', code: 'KeyW', metaKey: true })
    await waitFor(() => expect(names()).toEqual([]))
  })

  test('quick open ranks the project’s files from the server and opens the one picked', async () => {
    const { api } = fakeApi({ 'src/app.tsx': 'x\n' }, { files: async () => ({ files: [{ relative: 'src/app.tsx', score: 9, hits: [4, 5, 6] }], truncated: false }) })
    render(<Screen host={host()} api={api} Code={Plain} mac />)
    key({ key: 'p', code: 'KeyP', metaKey: true })
    const box = await screen.findByRole('combobox')
    fireEvent.change(box, { target: { value: 'app' } })
    await waitFor(() => expect(screen.getAllByTestId('picker-item')[0]!.textContent).toContain('app.tsx'))
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => expect(names()).toEqual(['app.tsx']))
  })

  test('the person’s own keys from the setting beat the defaults', async () => {
    const { api } = fakeApi({ 'a.ts': 'a\n' }, { keybindings: async () => ({ text: '[{ "key": "cmd+e", "command": "quickOpen.file" }, { "command": "-quickOpen.file", "key": "cmd+p" }]' }) })
    render(<Screen host={host()} api={api} Code={Plain} mac />)
    await act(() => new Promise((done) => setTimeout(done, 20)))
    key({ key: 'p', code: 'KeyP', metaKey: true })
    expect(screen.queryByRole('combobox')).toBeNull()
    key({ key: 'e', code: 'KeyE', metaKey: true })
    expect(await screen.findByRole('combobox')).toBeDefined()
  })
})

describe('go to definition', () => {
  function withHandle(offset: number) {
    handle = { focus() {}, openFind() {}, openReplace() {}, findNext() {}, findPrevious() {}, goTo: () => true, offset: () => offset, offsetAt: () => offset, lineCount: () => 3, wordAt: () => 'helper' }
  }

  test('one target opens in a new tab, kept, at its line', async () => {
    withHandle(5)
    const definition = async (): Promise<Definition> => ({ targets: [{ relative: 'lib/helper.ts', line: 12, column: 4 }], via: 'typescript', said: null })
    const { api } = fakeApi({ 'a.ts': 'helper()\n', 'lib/helper.ts': 'x\n' }, { definition })
    render(<Screen host={host({ passage: passage(`${ROOT}/a.ts`) })} api={api} Code={Plain} mac />)
    await waitFor(() => screen.getByLabelText('code'))
    act(() => screen.getByLabelText('code').focus())
    key({ key: 'F12', code: 'F12' })
    await waitFor(() => expect(names()).toEqual(['a.ts', 'helper.ts']))
    expect(within(tabs()[1]!).getByTestId('tab-name').className).not.toContain('italic')
    await waitFor(() => expect(seen.some((one) => one.reveal?.line === 12 && one.reveal.column === 5)).toBe(true))
  })

  test('nothing found is said in words', async () => {
    withHandle(5)
    const { api } = fakeApi({ 'a.ts': 'helper()\n' }, { definition: async () => ({ targets: [], via: null, said: 'No definition found for “helper”.' }) })
    render(<Screen host={host({ passage: passage(`${ROOT}/a.ts`) })} api={api} Code={Plain} mac />)
    await waitFor(() => screen.getByLabelText('code'))
    act(() => screen.getByLabelText('code').focus())
    key({ key: 'F12', code: 'F12' })
    await waitFor(() => expect(screen.getByTestId('notice').textContent).toBe('No definition found for “helper”.'))
  })

  test('several targets are a small list to pick from', async () => {
    withHandle(5)
    const definition = async (): Promise<Definition> => ({ targets: [{ relative: 'x.ts', line: 1, column: 0 }, { relative: 'y.ts', line: 2, column: 0 }], via: 'text', said: null })
    const { api } = fakeApi({ 'a.ts': 'helper()\n', 'y.ts': 'y\n' }, { definition })
    render(<Screen host={host({ passage: passage(`${ROOT}/a.ts`) })} api={api} Code={Plain} mac />)
    await waitFor(() => screen.getByLabelText('code'))
    act(() => screen.getByLabelText('code').focus())
    key({ key: 'F12', code: 'F12' })
    await waitFor(() => expect(screen.getAllByTestId('picker-item')).toHaveLength(2))
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' })
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' })
    await waitFor(() => expect(names()).toEqual(['a.ts', 'y.ts']))
  })
})

describe('search in project', () => {
  test('⇧⌘F shows it; results are grouped by file, and Enter opens a preview tab at the line', async () => {
    const answer: SearchAnswer = { files: [{ relative: 'src/b.ts', count: 1, matches: [{ line: 7, column: 2, length: 4, preview: '  term here', previewStart: 0 }] }], total: 1, truncated: false, timedOut: false }
    const asked: unknown[] = []
    const { api } = fakeApi({ 'src/b.ts': 'b\n' }, { search: async (_p, _id, query) => (asked.push(query), answer) })
    render(<Screen host={host()} api={api} Code={Plain} mac />)
    key({ key: 'f', code: 'KeyF', metaKey: true, shiftKey: true })
    const box = await screen.findByRole('searchbox')
    fireEvent.change(box, { target: { value: 'term' } })
    await waitFor(() => expect(screen.getByTestId('search-said').textContent).toBe('1 result in 1 file.'))
    expect(asked.at(-1)).toMatchObject({ query: 'term', caseSensitive: false, regex: false })
    fireEvent.keyDown(box, { key: 'Enter' })
    fireEvent.keyDown(screen.getByRole('tree'), { key: 'Enter' })
    await waitFor(() => expect(names()).toEqual(['b.ts']))
    expect(within(tabs()[0]!).getByTestId('tab-name').className).toContain('italic')
    await waitFor(() => expect(seen.some((one) => one.reveal?.line === 7 && one.reveal.column === 3)).toBe(true))
  })

  test('a regular expression that cannot be read is said in words', async () => {
    const { api } = fakeApi({}, { search: async () => ({ files: [], total: 0, truncated: false, timedOut: false, error: 'That is not a valid regular expression: missing )' }) })
    render(<Screen host={host()} api={api} Code={Plain} mac />)
    key({ key: 'f', code: 'KeyF', metaKey: true, shiftKey: true })
    fireEvent.change(await screen.findByRole('searchbox'), { target: { value: '(' } })
    await waitFor(() => expect(screen.getByTestId('search-said').textContent).toContain('not a valid regular expression'))
  })
})

describe('an agent’s orders', () => {
  test('several files open in the background, marked as the agent’s, at their lines', async () => {
    const { api, done, order } = fakeApi({ 'a.ts': 'a\n', 'b.ts': 'b\n', 'c.ts': 'c\n' })
    render(<Screen host={host({ passage: passage(`${ROOT}/a.ts`) })} api={api} Code={Plain} />)
    await waitFor(() => expect(names()).toEqual(['a.ts']))
    await order({ id: 'o1', kind: 'open', files: [{ relative: 'b.ts', line: 4 }, { relative: 'c.ts' }], focus: null, kehikko: null })
    await waitFor(() => expect(names()).toEqual(['a.ts', 'b.ts', 'c.ts']))
    expect(activeName()).toBe('a.ts')
    expect(within(tabs()[1]!).getByTestId('tab-agent').getAttribute('title')).toBe('Opened by an agent')
    expect(within(tabs()[1]!).getByTestId('tab-name').className).not.toContain('italic')
    expect(done[0]).toEqual({ id: 'o1', done: { opened: ['b.ts', 'c.ts'], focused: null, background: false } })
    fireEvent.click(tabs()[1]!)
    await waitFor(() => expect(within(tabs()[1]!).queryByTestId('tab-agent')).toBeNull())
    await waitFor(() => expect(seen.some((one) => one.reveal?.line === 4)).toBe(true))
  })

  test('focus is taken only when the person’s tab is unedited; otherwise it stays in front and says so', async () => {
    const { api, done, order } = fakeApi({ 'a.ts': 'a\n', 'b.ts': 'b\n' })
    render(<Screen host={host({ passage: passage(`${ROOT}/a.ts`) })} api={api} Code={Plain} />)
    await waitFor(() => screen.getByLabelText('code'))
    fireEvent.change(screen.getByLabelText('code'), { target: { value: 'typing\n' } })
    await order({ id: 'o2', kind: 'open', files: [{ relative: 'b.ts' }], focus: 'b.ts', kehikko: null })
    await waitFor(() => expect(names()).toEqual(['a.ts', 'b.ts']))
    expect(activeName()).toBe('a.ts')
    expect(done[0]!.done).toMatchObject({ focused: null, background: true })
  })

  test('with an unedited tab, focus moves to the file asked', async () => {
    const { api, done, order } = fakeApi({ 'a.ts': 'a\n', 'b.ts': 'b\n' })
    render(<Screen host={host({ passage: passage(`${ROOT}/a.ts`) })} api={api} Code={Plain} />)
    await waitFor(() => screen.getByLabelText('code'))
    await order({ id: 'o3', kind: 'open', files: [{ relative: 'b.ts' }], focus: 'b.ts', kehikko: null })
    await waitFor(() => expect(activeName()).toBe('b.ts'))
    expect(done[0]!.done).toMatchObject({ focused: 'b.ts' })
  })

  test('closing an unsaved tab is refused by naming it; the saved one closes', async () => {
    const { api, done, order } = fakeApi({ 'a.ts': 'a\n', 'b.ts': 'b\n' })
    const { rerender } = render(<Screen host={host({ passage: passage(`${ROOT}/a.ts`) })} api={api} Code={Plain} />)
    await waitFor(() => screen.getByLabelText('code'))
    fireEvent.change(screen.getByLabelText('code'), { target: { value: 'typing\n' } })
    rerender(<Screen host={host({ passage: passage(`${ROOT}/b.ts`) })} api={api} Code={Plain} />)
    await waitFor(() => expect(names()).toEqual(['a.ts', 'b.ts']))
    await order({ id: 'o4', kind: 'close', paths: ['a.ts', 'b.ts'], kehikko: null })
    await waitFor(() => expect(names()).toEqual(['a.ts']))
    expect(done[0]!.done).toEqual({ closed: ['b.ts'], kept: [{ relative: 'a.ts', why: 'it has unsaved changes' }] })
  })

  test('an order for another kehikko is left for that one', async () => {
    const { api, done, order } = fakeApi({ 'b.ts': 'b\n' })
    render(<Screen host={host({ kehikko: { id: 1, name: 'Writing', key: 'k1' } })} api={api} Code={Plain} />)
    await order({ id: 'o5', kind: 'open', files: [{ relative: 'b.ts' }], focus: null, kehikko: 'elsewhere' })
    expect(names()).toEqual([])
    expect(done).toEqual([])
  })
})

describe('keyboard shortcuts', () => {
  test('the JSON is checked as it is typed: a bad entry is said with its line, and Save keeps it as a machine setting', async () => {
    const saved: string[] = []
    const { api } = fakeApi({}, { keybindings: async () => ({ text: '' }), saveKeybindings: async (text) => (saved.push(text), true) })
    const press = { current: (_: unknown): unknown => undefined }
    render(<Screen host={host()} api={api} Code={Plain} press={press as never} mac />)
    act(() => void press.current({ item: 'keybindings.openJson' }))
    const view = await screen.findByTestId('keybindings')
    fireEvent.change(within(view).getByLabelText('code'), { target: { value: '[\n{ "key": "cmd+e", "command": "palette.show" },\n{ "key": "cmd+nope", "command": "palette.show" }\n]' } })
    await waitFor(() => expect(screen.getByTestId('keybindings-problems').textContent).toContain('Line 3:'))
    fireEvent.click(screen.getByTestId('keybindings-save'))
    await waitFor(() => expect(saved).toHaveLength(1))
    await waitFor(() => expect(screen.getByTestId('keybindings').textContent).toContain('1 entry is skipped until fixed'))
    /* Saved keys are in use at once. */
    fireEvent.click(within(screen.getByTestId('keybindings')).getByText('Close'))
    key({ key: 'e', code: 'KeyE', metaKey: true })
    expect(await screen.findByRole('combobox')).toBeDefined()
  })

  test('the list shows every command with its keys, searchable', async () => {
    const { api } = fakeApi({})
    const press = { current: (_: unknown): unknown => undefined }
    render(<Screen host={host()} api={api} Code={Plain} press={press as never} mac />)
    act(() => void press.current({ item: 'keybindings.open' }))
    const list = await screen.findByTestId('keybindings-list')
    expect(list.textContent).toContain('Go to definition')
    expect(list.textContent).toContain('F12')
    fireEvent.change(screen.getByLabelText('Search commands and keys'), { target: { value: 'symbol in project' } })
    await waitFor(() => expect(within(screen.getByTestId('keybindings-list')).getAllByRole('row')).toHaveLength(2))
  })
})
