import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DOOR_PROJECT_SAYS, WELL_KNOWN, manifestSchema } from 'kehikot-module-protocol'

import { MANIFEST, READ_ONLY_DOOR, TICKET, answer, setHostResolve } from '../doors.ts'
import { forgetKnown } from '../file/confine.ts'
import { forgetEditing } from '../file/editing.ts'
import { ID } from '../manifest.ts'

const scratch = mkdtempSync(join(tmpdir(), 'editor-doors-'))
const project = realpathSync(scratch)
const moved = realpathSync(mkdtempSync(join(tmpdir(), 'editor-doors-moved-')))
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
  rmSync(moved, { recursive: true, force: true })
  setHostResolve(null)
})

writeFileSync(join(project, 'a.txt'), 'one\n')
writeFileSync(join(project, '.env'), 'TOKEN=FAKE\n')
writeFileSync(join(moved, 'a.txt'), 'moved one\n')

/** The host holds `project`; `moved-from` is a former path of `moved`; anything else it does not hold. */
beforeEach(() => {
  forgetKnown()
  forgetEditing()
  setHostResolve(async (folder) => {
    if (folder === project) return { ok: true, path: project }
    if (folder === '/old/place') return { ok: true, path: moved, movedFrom: '/old/place' }
    return { ok: false, reason: 'not-project', why: DOOR_PROJECT_SAYS.notProject(folder) }
  })
})

const none = new URLSearchParams()
const q = (fields: Record<string, string>) => new URLSearchParams(fields)

async function rpc(method: string, params: Record<string, unknown> = {}) {
  const reply = await answer('POST', '/mcp', none, { jsonrpc: '2.0', id: 1, method, params }, null)
  return reply?.body as {
    result?: { tools?: { name: string; annotations?: { readOnlyHint?: boolean } }[]; content?: { text: string }[]; isError?: boolean }
  }
}

async function openA(projectPath = project) {
  const reply = await answer('GET', '/api/open', q({ projectPath, path: 'a.txt' }), null, TICKET)
  return reply?.body as { ok: boolean; version: string; text: string; error?: string }
}

describe('the doors', () => {
  test('the health check says which module this is, and that agents only read', async () => {
    const reply = await answer('GET', '/healthz', none, null, null)
    expect(reply?.status).toBe(200)
    expect((reply?.body as { id: string; agents: string }).id).toBe(ID)
    expect((reply?.body as { agents: string }).agents).toBe('read-only')
  })

  test('the manifest is this module’s and a host would accept it', () => {
    expect(WELL_KNOWN.startsWith('/')).toBe(true)
    expect(manifestSchema.safeParse(MANIFEST).success).toBe(true)
    expect(MANIFEST.id).toBe(ID)
  })

  test('a path that is not ours is left to Vite', async () => {
    expect(await answer('GET', '/src/main.tsx', none, null, null)).toBeNull()
  })

  test('every /api route asks for this page’s ticket, reads too', async () => {
    const asks: [string, string, URLSearchParams, Record<string, unknown> | null][] = [
      ['GET', '/api/open', q({ projectPath: project, path: 'a.txt' }), null],
      ['GET', '/api/stamp', q({ projectPath: project, path: 'a.txt' }), null],
      ['POST', '/api/save', none, { projectPath: project, path: 'a.txt', text: 'pwned\n', base: 'x' }],
      ['POST', '/api/editing', none, { projectPath: project, relative: 'a.txt' }],
    ]
    for (const [method, path, query, body] of asks) {
      for (const ticket of [null, 'not-the-ticket']) {
        expect([path, ticket, (await answer(method, path, query, body, ticket))?.status]).toEqual([path, ticket, 403])
      }
    }
    expect(readFileSync(join(project, 'a.txt'), 'utf8')).toBe('one\n')
  })

  test('the page opens, saves at its base, and is refused when the file changed underneath', async () => {
    const opened = await openA()
    expect(opened.text).toBe('one\n')
    const saved = await answer('POST', '/api/save', none, { projectPath: project, path: 'a.txt', text: 'two\n', base: opened.version }, TICKET)
    expect(saved?.status).toBe(200)
    expect(readFileSync(join(project, 'a.txt'), 'utf8')).toBe('two\n')

    /* The same base again: the file is no longer that version. */
    const stale = await answer('POST', '/api/save', none, { projectPath: project, path: 'a.txt', text: 'three\n', base: opened.version }, TICKET)
    expect(stale?.status).toBe(409)
    expect((stale?.body as { kind: string; text: string }).kind).toBe('conflict')
    expect((stale?.body as { text: string }).text).toBe('two\n')
    expect(readFileSync(join(project, 'a.txt'), 'utf8')).toBe('two\n')
  })

  test('a folder the host does not hold is neither read nor written', async () => {
    const other = realpathSync(mkdtempSync(join(tmpdir(), 'editor-doors-other-')))
    writeFileSync(join(other, 'a.txt'), 'other\n')
    expect((await openA(other)).ok).toBe(false)
    const saved = await answer('POST', '/api/save', none, { projectPath: other, path: 'a.txt', text: 'pwned\n', base: '1:1:' + 'a'.repeat(64) }, TICKET)
    expect(saved?.status).toBe(400)
    expect(readFileSync(join(other, 'a.txt'), 'utf8')).toBe('other\n')
    rmSync(other, { recursive: true, force: true })
  })

  test('a project that moved is followed to where it is now, so a save lands there and not at the old path', async () => {
    const opened = await openA('/old/place')
    expect(opened.text).toBe('moved one\n')
    const saved = await answer('POST', '/api/save', none, { projectPath: '/old/place', path: 'a.txt', text: 'moved two\n', base: opened.version }, TICKET)
    expect(saved?.status).toBe(200)
    expect(readFileSync(join(moved, 'a.txt'), 'utf8')).toBe('moved two\n')
  })
})

describe('the agent door only reads', () => {
  test('its one tool says it only reads', async () => {
    const tools = (await rpc('tools/list')).result?.tools ?? []
    expect(tools.map((tool) => tool.name)).toEqual(['editing'])
    for (const tool of tools) expect(tool.annotations?.readOnlyHint).toBe(true)
  })

  test('asking it to save, write or anything else is refused, and the file is untouched', async () => {
    for (const name of ['save', 'write_file', 'edit', 'revert', 'reload', 'shown', '']) {
      const called = (await rpc('tools/call', { name, arguments: { project, path: 'a.txt', text: 'pwned\n' } })).result
      expect([name, called?.isError, called?.content?.[0]?.text.includes(READ_ONLY_DOOR)]).toEqual([name, true, true])
    }
    expect(readFileSync(join(project, 'a.txt'), 'utf8')).not.toContain('pwned')
  })

  test('it says what the page has open, with the unsaved text only when asked', async () => {
    await openA()
    await answer('POST', '/api/editing', none, { projectPath: project, relative: 'a.txt', dirty: true, text: 'unsaved words\n', version: null }, TICKET)
    const plain = (await rpc('tools/call', { name: 'editing', arguments: { project } })).result?.content?.[0]?.text ?? ''
    expect(plain).toContain('a.txt')
    expect(plain).toContain('not saved')
    expect(plain).not.toContain('unsaved words')
    const withText = (await rpc('tools/call', { name: 'editing', arguments: { project, text: true } })).result?.content?.[0]?.text ?? ''
    expect(withText).toContain('unsaved words')
  })

  test('a file agents may not read is not named, and its text is not given', async () => {
    await openA()
    await answer('POST', '/api/editing', none, { projectPath: project, relative: '.env', dirty: true, text: 'TOKEN=SECRET\n', hidden: true }, TICKET)
    const said = (await rpc('tools/call', { name: 'editing', arguments: { project, text: true } })).result?.content?.[0]?.text ?? ''
    expect(said).not.toContain('.env')
    expect(said).not.toContain('SECRET')
  })

  test('a project its page has not been opened on is refused', async () => {
    const called = (await rpc('tools/call', { name: 'editing', arguments: { project } })).result
    expect(called?.isError).toBe(true)
  })
})

describe('the folder layout', () => {
  test('nothing is kept in the project: no .kehikot/editor folder is made', async () => {
    mkdirSync(join(project, 'sub'), { recursive: true })
    await openA()
    expect(() => readFileSync(join(project, '.kehikot', 'editor'))).toThrow()
  })
})
