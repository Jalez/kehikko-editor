import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { DOOR_PROJECT_SAYS } from 'kehikot-module-protocol'

import { TICKET, answer, setHostResolve } from '../doors.ts'
import { forgetKnown } from '../file/confine.ts'
import { forgetServices } from '../file/definition.ts'
import { forgetOutlines } from '../file/symbols.ts'
import { forgetWalks } from '../file/walk.ts'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'editor-intel-')))
const project = join(scratch, 'project')
const outside = join(scratch, 'outside')

function put(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

put(join(project, 'src', 'app.ts'), "import { helper } from './helper'\n\nhelper()\n")
put(join(project, 'src', 'helper.ts'), 'export function helper() {\n  return 42\n}\n')
put(join(project, 'docs', 'guide.md'), '# Guide\n\n## Start\n\nCall helper.\n')
put(join(project, 'keys', 'id_rsa'), 'helper private key\n')
put(join(outside, 'secret.ts'), 'export function helper() {}\n')
symlinkSync(join(outside, 'secret.ts'), join(project, 'escape.ts'))

afterAll(() => {
  forgetServices()
  setHostResolve(null)
  rmSync(scratch, { recursive: true, force: true })
})

beforeEach(() => {
  forgetKnown()
  forgetWalks()
  forgetOutlines()
  setHostResolve(async (folder) => {
    if (folder === project) return { ok: true, path: project }
    return { ok: false, reason: 'not-project', why: DOOR_PROJECT_SAYS.notProject(folder) }
  })
})

const none = new URLSearchParams()
const q = (fields: Record<string, string>) => new URLSearchParams(fields)
type Body = Record<string, any>

async function get(path: string, fields: Record<string, string>, ticket: string | null = TICKET) {
  const reply = await answer('GET', path, q(fields), null, ticket)
  return { status: reply?.status, body: reply?.body as Body }
}
async function post(path: string, body: Record<string, unknown>, ticket: string | null = TICKET) {
  const reply = await answer('POST', path, none, body, ticket)
  return { status: reply?.status, body: reply?.body as Body }
}

describe('the code-navigation routes', () => {
  test('every one asks for the page’s ticket', async () => {
    for (const ticket of [null, 'not-the-ticket']) {
      expect((await get('/api/files', { projectPath: project, query: 'app' }, ticket)).status).toBe(403)
      expect((await get('/api/symbols', { projectPath: project, query: 'helper' }, ticket)).status).toBe(403)
      expect((await post('/api/search', { projectPath: project, query: 'helper' }, ticket)).status).toBe(403)
      expect((await post('/api/definition', { projectPath: project, path: 'src/app.ts', offset: 0 }, ticket)).status).toBe(403)
      expect((await post('/api/outline', { projectPath: project, path: 'src/app.ts' }, ticket)).status).toBe(403)
    }
  })

  test('quick open ranks the project’s files, never a link out or a key', async () => {
    const { status, body } = await get('/api/files', { projectPath: project, query: 'helper' })
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.truncated).toBe(false)
    expect(body.files[0]).toMatchObject({ relative: 'src/helper.ts' })
    expect(Array.isArray(body.files[0].hits)).toBe(true)
    const all = (await get('/api/files', { projectPath: project, query: 'e' })).body.files.map((one: Body) => one.relative)
    expect(all).not.toContain('escape.ts')
    expect(all).not.toContain('keys/id_rsa')
  })

  test('search finds in the project and not past the fence or in a key', async () => {
    const { status, body } = await post('/api/search', { projectPath: project, searchId: 'one', query: 'helper', caseSensitive: true })
    expect(status).toBe(200)
    const files = body.files.map((one: Body) => one.relative)
    expect(files.sort()).toEqual(['docs/guide.md', 'src/app.ts', 'src/helper.ts'])
    expect(body).toMatchObject({ ok: true, truncated: false, timedOut: false, cancelled: false })
    const broken = await post('/api/search', { projectPath: project, query: '(', regex: true })
    expect(broken.body.error).toStartWith('That is not a valid regular expression')
    const tooMany = await post('/api/search', { projectPath: project, query: 'x', include: Array.from({ length: 40 }, () => '*.ts') })
    expect(tooMany.status).toBe(400)
  })

  test('definition, outline and project symbols answer', async () => {
    const text = "import { helper } from './helper'\n\nhelper()\n"
    const found = await post('/api/definition', { projectPath: project, path: join(project, 'src', 'app.ts'), offset: text.lastIndexOf('helper') + 1 })
    expect(found.status).toBe(200)
    expect(found.body).toMatchObject({ ok: true, via: 'typescript', said: null })
    expect(found.body.targets[0]).toMatchObject({ relative: 'src/helper.ts', line: 1 })

    const outline = await post('/api/outline', { projectPath: project, path: 'docs/guide.md' })
    expect(outline.body.symbols.map((one: Body) => one.name)).toEqual(['Guide', 'Start'])

    const symbols = await get('/api/symbols', { projectPath: project, query: 'helpr' })
    expect(symbols.body.symbols[0]).toMatchObject({ name: 'helper', kind: 'function', relative: 'src/helper.ts', line: 1, container: null })
  })

  test('a path outside the project, or a project the host does not hold, is refused', async () => {
    for (const path of ['../outside/secret.ts', join(outside, 'secret.ts'), 'escape.ts', 'keys/id_rsa']) {
      const refused = await post('/api/definition', { projectPath: project, path, offset: 0 })
      expect([path, refused.status, refused.body.ok]).toEqual([path, 404, false])
      const outline = await post('/api/outline', { projectPath: project, path })
      expect([path, outline.status]).toEqual([path, 404])
    }
    const stranger = await get('/api/files', { projectPath: outside, query: 'secret' })
    expect(stranger.status).toBe(400)
    expect(stranger.body.ok).toBe(false)
    const search = await post('/api/search', { projectPath: outside, query: 'helper' })
    expect(search.status).toBe(400)
  })

  test('text larger than the editor opens is refused', async () => {
    const big = 'x'.repeat(1_048_577)
    const refused = await post('/api/outline', { projectPath: project, path: 'src/app.ts', text: big })
    expect(refused.status).toBe(413)
  })
})
