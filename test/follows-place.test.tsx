import { afterEach, test } from 'bun:test'
import { act, cleanup, render } from '@testing-library/react'
import { expectFollowsPlace } from 'kehikot-module-protocol/testing'
import type { Passage } from 'kehikot-module-protocol'

import { Screen, type Host } from '../src/app.tsx'
import type { CodeEditorProps } from '../src/view/code-editor.tsx'
import type { Api, Opened } from '../src/wire/api.ts'

/**
 * The shared check for a module that follows the place (protocol 2.105.0): switching to a space the canvas
 * points at nothing in shows nothing of the space before — no tab, no text — and switching back brings the
 * file back. The editor's own tests (`places.test.tsx`) hold the finer rules (kept tabs stay).
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
const host = (over: Partial<Host>): Host => ({ where: 'hosted', project: 'Thesis', projectPath: ROOT, projectId: null, passage: null, header: () => {}, ...over })

/** CodeMirror does not lay out without a layout engine; a textarea with the same props stands in. */
function Plain({ text, readOnly, onChange }: CodeEditorProps) {
  return <textarea aria-label="code" defaultValue={text} readOnly={readOnly} onChange={(event) => onChange(event.target.value)} />
}

const api: Api = {
  changes: (_p, _path, onChange) => (onChange(), () => {}),
  async open(_p, path) {
    const relative = path.replace(`${ROOT}/`, '')
    const body: Opened = { root: ROOT, path, relative, text: 'the thesis text\n', version: 'v1', eol: '\n', language: null, readOnly: null, hidden: false }
    return { ok: true, status: 200, body }
  },
  async stamp() {
    return null
  },
  async save() {
    return { kind: 'saved', version: 'v2', unchanged: false }
  },
  async editing() {},
  orders: () => () => {},
  heldOrders: async () => [],
  ordersDone: async () => {},
}

type Place = Partial<Host>
const space = (...ids: string[]): Place => ({ epic: ids[0] ?? null, context: { space: { path: ids.map((id) => ({ id })), picked: [] } } as never })

test('switching to a space the canvas points at nothing in shows nothing of the space before', async () => {
  await expectFollowsPlace<Place, { rerender: (place: Place) => void }>({
    render: (place) => {
      const view = render(<Screen host={host(place)} api={api} Code={Plain} />)
      return { rerender: (next) => view.rerender(<Screen host={host(next)} api={api} Code={Plain} />) }
    },
    switchTo: (shown, place) => act(async () => shown.rerender(place)),
    text: () => document.body.textContent ?? '',
    filled: { place: { ...space('thesis', 'one'), passage: passage(`${ROOT}/chapter-one.ts`) }, marker: 'the thesis text' },
    empty: { ...space('thesis', 'two'), passage: null },
  })
})
