import { afterEach, describe, expect, test } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Passage } from 'kehikot-module-protocol'

import { Screen, type Host } from '../src/app.tsx'
import type { CodeEditorProps } from '../src/view/code-editor.tsx'
import type { Api, Opened, SaveAnswer } from '../src/wire/api.ts'

afterEach(() => {
  cleanup()
  try {
    sessionStorage.clear()
    localStorage.clear()
  } catch {
    /* none */
  }
})

const passage = (path: string): Passage => ({ path, page: null, from: null, to: null, quoted: '', section: null })

function host(over: Partial<Host> = {}): Host {
  return {
    where: 'hosted',
    project: 'Thesis',
    projectPath: '/work/thesis',
    projectId: null,
    passage: passage('/work/thesis/a.ts'),
    header: () => {},
    ...over,
  }
}

/** CodeMirror does not lay out without a layout engine; a textarea stands in, with the same props. */
function Plain({ text, generation, readOnly, onChange, onSave }: CodeEditorProps) {
  return (
    <textarea
      key={generation}
      aria-label="code"
      defaultValue={text}
      readOnly={readOnly}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 's' && event.metaKey) {
          event.preventDefault()
          onSave()
        }
      }}
    />
  )
}

function fakeApi(files: Record<string, Partial<Opened>>, onSave: (path: string, text: string, base: string) => SaveAnswer = () => ({ kind: 'saved', version: 'v2', unchanged: false })) {
  const saves: { path: string; text: string; base: string }[] = []
  const api: Api = {
    async open(_projectPath, path) {
      const file = files[path]
      if (!file) return { ok: false, kind: 'refused', status: 404, error: 'That file is not somewhere this app can look.', body: null }
      return {
        ok: true,
        status: 200,
        body: { root: '/work/thesis', path, relative: path.replace('/work/thesis/', ''), text: '', version: 'v1', eol: '\n', language: null, readOnly: null, hidden: false, ...file },
      }
    },
    async stamp() {
      return null
    },
    async save(_projectPath, path, text, base) {
      saves.push({ path, text, base })
      return onSave(path, text, base)
    },
    async editing() {},
  }
  return { api, saves }
}

describe('the editor page', () => {
  test('opens the file the canvas points at, clean', async () => {
    const { api } = fakeApi({ '/work/thesis/a.ts': { text: 'const a = 1\n' } })
    render(<Screen host={host()} api={api} Code={Plain} />)
    await waitFor(() => expect(screen.getByTestId('name').textContent).toBe('a.ts'))
    expect((screen.getByLabelText('code') as HTMLTextAreaElement).value).toBe('const a = 1\n')
    expect(screen.queryByTestId('unsaved')).toBeNull()
    expect((screen.getByTestId('save') as HTMLButtonElement).disabled).toBe(true)
  })

  test('an edit marks it unsaved and enables Save; ⌘S saves with the version the edit started from', async () => {
    const { api, saves } = fakeApi({ '/work/thesis/a.ts': { text: 'one\n', version: 'v1' } })
    render(<Screen host={host()} api={api} Code={Plain} />)
    await waitFor(() => screen.getByLabelText('code'))
    fireEvent.change(screen.getByLabelText('code'), { target: { value: 'two\n' } })
    expect(screen.getByTestId('unsaved')).toBeDefined()
    expect((screen.getByTestId('save') as HTMLButtonElement).disabled).toBe(false)
    fireEvent.keyDown(screen.getByLabelText('code'), { key: 's', metaKey: true })
    await waitFor(() => expect(saves).toEqual([{ path: '/work/thesis/a.ts', text: 'two\n', base: 'v1' }]))
    await waitFor(() => expect(screen.queryByTestId('unsaved')).toBeNull())
    expect(screen.getByTestId('said').textContent).toBe('Saved.')
  })

  test('a refused save keeps the edit, says the file changed on disk, and offers a reload and a comparison', async () => {
    const { api } = fakeApi({ '/work/thesis/a.ts': { text: 'one\n' } }, () => ({
      kind: 'conflict',
      version: 'v9',
      text: 'theirs\n',
      said: 'The file changed on disk since you started editing it, so nothing was saved.',
    }))
    render(<Screen host={host()} api={api} Code={Plain} />)
    await waitFor(() => screen.getByLabelText('code'))
    fireEvent.change(screen.getByLabelText('code'), { target: { value: 'mine\n' } })
    fireEvent.click(screen.getByTestId('save'))
    await waitFor(() => expect(screen.getByTestId('changed').textContent).toContain('changed on disk'))
    expect(screen.getByTestId('unsaved')).toBeDefined()
    fireEvent.click(screen.getByTestId('compare'))
    await waitFor(() => expect(screen.getByTestId('comparison').textContent).toContain('theirs'))
    expect(screen.getByTestId('comparison').textContent).toContain('mine')
    expect(screen.getByTestId('reload')).toBeDefined()
  })

  test('a read-only file says whose it is and offers no Save', async () => {
    const owned = 'This is Paper’s LaTeX source. Paper edits it through its proposals.'
    const { api } = fakeApi({ '/work/thesis/.kehikot/paper/t/main.tex': { text: 'x', readOnly: owned } })
    render(<Screen host={host({ passage: passage('/work/thesis/.kehikot/paper/t/main.tex') })} api={api} Code={Plain} />)
    await waitFor(() => expect(screen.getByTestId('why-read-only').textContent).toBe(owned))
    expect(screen.getByTestId('read-only')).toBeDefined()
    expect(screen.queryByTestId('save')).toBeNull()
    expect((screen.getByLabelText('code') as HTMLTextAreaElement).readOnly).toBe(true)
  })

  test('with unsaved changes, a new passage does not take the file away; it asks', async () => {
    const { api } = fakeApi({ '/work/thesis/a.ts': { text: 'one\n' }, '/work/thesis/b.ts': { text: 'bee\n' } })
    const { rerender } = render(<Screen host={host()} api={api} Code={Plain} />)
    await waitFor(() => screen.getByLabelText('code'))
    fireEvent.change(screen.getByLabelText('code'), { target: { value: 'edited\n' } })
    rerender(<Screen host={host({ passage: passage('/work/thesis/b.ts') })} api={api} Code={Plain} />)
    await waitFor(() => expect(screen.getByTestId('pending').textContent).toContain('b.ts'))
    expect(screen.getByTestId('name').textContent).toBe('a.ts')
    fireEvent.click(screen.getByText('Open it'))
    await waitFor(() => expect(screen.getByTestId('name').textContent).toBe('b.ts'))
  })

  test('unsaved changes are kept as a draft per project and file, and come back', async () => {
    const files = { '/work/thesis/a.ts': { text: 'one\n', version: 'v1' } }
    const first = fakeApi(files)
    render(<Screen host={host({ projectId: 'thesis-0a1b2c' })} api={first.api} Code={Plain} />)
    await waitFor(() => screen.getByLabelText('code'))
    fireEvent.change(screen.getByLabelText('code'), { target: { value: 'draft\n' } })
    await act(() => new Promise((done) => setTimeout(done, 300)))
    cleanup()
    /* The project was renamed: a new path, the same id. */
    const moved = { '/work/renamed/a.ts': { text: 'one\n', version: 'v1', relative: 'a.ts' } }
    const second = fakeApi(moved)
    render(<Screen host={host({ projectId: 'thesis-0a1b2c', projectPath: '/work/renamed', passage: passage('/work/renamed/a.ts') })} api={second.api} Code={Plain} />)
    await waitFor(() => expect((screen.getByLabelText('code') as HTMLTextAreaElement).value).toBe('draft\n'))
    expect(screen.getByTestId('unsaved')).toBeDefined()
    expect(screen.getByTestId('said').textContent).toContain('unsaved changes are back')
  })

  test('the header it declares has Save, Reload, Revert and Wrap, and none for agents', async () => {
    const declared: { id: string; agents: boolean }[][] = []
    const { api } = fakeApi({ '/work/thesis/a.ts': { text: 'one\n' } })
    render(<Screen host={host({ header: (items) => void declared.push(items as { id: string; agents: boolean }[]) })} api={api} Code={Plain} />)
    await waitFor(() => expect(declared.at(-1)?.map((item) => item.id)).toEqual(['save', 'reload', 'revert', 'wrap', 'recent']))
    expect(declared.at(-1)?.every((item) => !item.agents)).toBe(true)
  })

  test('each not-ready state is the shared cover', () => {
    const none = { projectPath: null, project: null, passage: null }
    for (const [where, state] of [['listening', 'waiting'], ['unhosted', 'unhosted'], ['hosted', 'no-project']] as const) {
      const { container } = render(<Screen host={host({ ...none, where })} api={fakeApi({}).api} Code={Plain} />)
      expect(container.querySelector('[data-cover]')?.getAttribute('data-cover')).toBe(state)
      cleanup()
    }
  })
})
