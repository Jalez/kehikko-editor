import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DOOR_PROJECT_SAYS } from 'kehikot-module-protocol'
import { attach } from 'kehikot-module-protocol/serve'

import { TICKET, answer, setHostResolve } from '../doors.ts'
import { forgetKnown } from '../file/confine.ts'
import { forgetEditing } from '../file/editing.ts'
import { forgetTabs, ordersTopic } from '../file/tabs.ts'

/**
 * The agent door's tabs: open_files, tabs, focus_tab and close_tabs reach the person's page through
 * its own stream, are held while no page is open, and never discard an edit.
 */

const scratch = mkdtempSync(join(tmpdir(), 'editor-tabs-door-'))
const project = realpathSync(scratch)
const outside = realpathSync(mkdtempSync(join(tmpdir(), 'editor-tabs-outside-')))
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
  setHostResolve(null)
})
mkdirSync(join(project, 'src'))
writeFileSync(join(project, 'src', 'a.ts'), 'export const a = 1\n')
writeFileSync(join(project, 'src', 'b.ts'), 'export const b = 2\n')
writeFileSync(join(project, '.env'), 'TOKEN=FAKE\n')
writeFileSync(join(outside, 'secret.txt'), 'no\n')

beforeEach(() => {
  forgetKnown()
  forgetEditing()
  forgetTabs()
  setHostResolve(async (folder) => (folder === project ? { ok: true, path: project } : { ok: false, reason: 'not-project', why: DOOR_PROJECT_SAYS.notProject(folder) }))
})

const none = new URLSearchParams()
async function tool(name: string, args: Record<string, unknown>) {
  const reply = await answer('POST', '/mcp', none, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, null)
  const result = (reply?.body as { result: { content: { text: string }[]; isError?: boolean } }).result
  return { text: result.content[0]!.text, error: result.isError === true }
}

/** A page open on the project: it reports its tabs, follows its orders stream, and answers each order. */
async function page(answerWith: (order: { id: string; kind: string; [key: string]: unknown }) => Record<string, unknown> | null) {
  await answer('POST', '/api/editing', none, { projectPath: project, relative: null, page: 'p1', tabs: [{ relative: 'src/a.ts', dirty: true, active: true }] }, TICKET)
  const orders: { id: string; kind: string; [key: string]: unknown }[] = []
  const follow = attach(ordersTopic(project), (data) => {
    const parsed = (typeof data === 'string' ? JSON.parse(data) : data) as { orders: { id: string; kind: string }[] }
    for (const order of parsed.orders) {
      orders.push(order)
      const done = answerWith(order)
      if (done) void answer('POST', '/api/orders/done', none, { id: order.id, done }, TICKET)
    }
  })
  return { orders, stop: () => follow?.close() }
}

describe('open_files', () => {
  test('opens several files at lines, and says what the page did', async () => {
    const open = await page((order) => ({ opened: (order.files as { relative: string }[]).map((one) => one.relative), focused: null, background: true }))
    const said = await tool('open_files', { project, files: [{ path: 'src/a.ts', line: 3, column: 2 }, { path: join(project, 'src/b.ts'), line: 1, endLine: 1, endColumn: 5 }] })
    expect(said.error).toBe(false)
    expect(open.orders[0]).toMatchObject({ kind: 'open', files: [{ relative: 'src/a.ts', line: 3, column: 2 }, { relative: 'src/b.ts', line: 1, endLine: 1, endColumn: 5 }] })
    expect(said.text).toContain('Opened as tabs: src/a.ts, src/b.ts.')
    expect(said.text).toContain('background')
    open.stop()
  })

  test('a file outside the project, missing, or one agents may not read is refused in words, and not sent', async () => {
    const open = await page(() => ({ opened: [] }))
    const said = await tool('open_files', { project, files: [{ path: join(outside, 'secret.txt') }, { path: 'nope.ts' }, { path: '.env' }, { path: '../x' }] })
    expect(said.error).toBe(true)
    expect(said.text).toContain('Nothing was opened.')
    expect(said.text).toContain('not somewhere this app can look')
    expect(open.orders).toEqual([])
    open.stop()
  })

  test('with no page open, the files are held, said so, and handed to the next page', async () => {
    const said = await tool('open_files', { project, files: [{ path: 'src/a.ts' }] })
    expect(said.text).toContain('No Editor page is open')
    expect(said.text).toContain('held')
    const held = await answer('POST', '/api/orders/held', none, { projectPath: project }, TICKET)
    expect((held?.body as { orders: { files: { relative: string }[] }[] }).orders[0]!.files[0]!.relative).toBe('src/a.ts')
    const again = await answer('POST', '/api/orders/held', none, { projectPath: project }, TICKET)
    expect((again?.body as { orders: unknown[] }).orders).toEqual([])
  })

  test('the held orders are the page’s only: refused without its ticket', async () => {
    const held = await answer('POST', '/api/orders/held', none, { projectPath: project }, null)
    expect(held?.status).toBe(403)
  })
})

describe('the other tab tools', () => {
  test('tabs lists what the page reported, unsaved named', async () => {
    await answer('POST', '/api/editing', none, { projectPath: project, page: 'p1', kehikko: { key: 'k1', name: 'Writing' }, tabs: [{ relative: 'src/a.ts', dirty: true, active: true }, { relative: 'src/b.ts', agent: true, preview: true }] }, TICKET)
    const said = await tool('tabs', { project })
    expect(said.text).toContain('- src/a.ts (active, UNSAVED)')
    expect(said.text).toContain('- src/b.ts (preview, opened by an agent)')
    expect(said.text).toContain('unsaved changes')
  })

  test('close_tabs: an unsaved tab is kept and named; a saved one closes', async () => {
    const open = await page((order) => ({ closed: ['src/b.ts'], kept: [{ relative: 'src/a.ts', why: 'it has unsaved changes' }], _: order.id }))
    const said = await tool('close_tabs', { project, paths: ['src/a.ts', 'src/b.ts'] })
    expect(said.text).toContain('Closed: src/b.ts.')
    expect(said.text).toContain('Kept open: src/a.ts — it has unsaved changes')
    open.stop()
  })

  test('focus_tab and close_tabs with no page say there are no tabs', async () => {
    expect((await tool('focus_tab', { project, path: 'src/a.ts' })).text).toContain('no tabs to act on')
    expect((await tool('close_tabs', { project, paths: ['src/a.ts'] })).text).toContain('no tabs to act on')
  })

  test('commands lists every command with its keys, read-only', async () => {
    const said = await tool('commands', {})
    expect(said.text).toContain('editor.goToDefinition')
    expect(said.text).toContain('F12')
    expect(said.text).toContain('cannot press them')
  })

  test('the keyboard shortcuts are a machine setting the page saves with its ticket, and bad text is still kept', async () => {
    const get = await answer('GET', '/api/kehikot/settings', none, null, null)
    expect((get?.body as { values: { keybindings: string } }).values.keybindings).toBe('')
    const text = '[{ "key": "cmd+e", "command": "palette.show" }]'
    const set = await answer('POST', '/api/kehikot/settings', none, { key: 'keybindings', value: text, by: 'person' }, TICKET)
    expect((set?.body as { outcome: string }).outcome).toBe('saved')
    const after = await answer('GET', '/api/kehikot/settings', none, null, null)
    expect((after?.body as { values: { keybindings: string } }).values.keybindings).toBe(text)
    expect((await tool('commands', {})).text).toContain('[theirs]')
    const tooLong = await answer('POST', '/api/kehikot/settings', none, { key: 'keybindings', value: 'x'.repeat(5000), by: 'person' }, TICKET)
    expect((tooLong?.body as { outcome: string }).outcome).toBe('refused')
  })
})
