import { DOOR_PROJECT_SAYS, doorContext } from 'kehikot-module-protocol'
import { establishBuild, mintTicket, refuseTicket, type Reply } from 'kehikot-module-protocol/serve'

import { configuredRoots, rootOf } from './file/confine.ts'
import { describe, editingIn, report } from './file/editing.ts'
import { locate, open, stampOf } from './file/open.ts'
import { save } from './file/save.ts'
import { MAX_BYTES, MAX_PATH, bytes, str } from './file/shape.ts'
import { resolveProject, type Resolve } from './host-ask.ts'
import { makeStream, saved as told } from './live.ts'
import { ID, MANIFEST, VERSION } from './manifest.ts'

/**
 * Every door but the page, as one function: `answer` takes a request and returns
 * a status and a body, or `null` for "not ours, let Vite have it". `doors()` in
 * vite.config.ts is the only thing that touches a socket.
 *
 * ## Who may do what
 *
 *  - **The page** carries the ticket this process printed into it. It may open a
 *    file, watch its version, SAVE it, and say what it has open. Every `/api`
 *    route asks for the ticket — reads too, because what is read here is a
 *    file's contents.
 *  - **An agent** at `/mcp` has no ticket and is never handed a write. Its one
 *    tool reads what the page said it has open. Agents edit files with their own
 *    tools; the person saves here.
 *  - **Anything else** on this machine that found the port gets the health check.
 *
 * Every project a request names is asked of the host first (`resolveDoorProject`,
 * protocol 2.3.0): a folder the host does not hold is not read and not written,
 * and a project that moved is followed to where it is now, so a save never lands
 * in a folder the project left.
 */

export const BUILD = establishBuild({ version: VERSION, dir: import.meta.dirname })

/** Minted per process and printed into `/app`; only this app's own page holds it. */
export const TICKET = mintTicket()

const ok = (body: unknown): Reply => ({ status: 200, body })
const bad = (why: string, status = 400): Reply => ({ status, body: { ok: false, error: why } })

const NO_ROOT_PAGE = 'Nothing has said which project is open, so there is nothing to edit.'
const NOT_A_PROJECT_PAGE =
  'That folder is not open as a project here. The Editor edits files of a project the app has open — never of a home '
  + 'folder or a whole disk — and, when its operator has listed directories, only what is inside them.'
const NOT_READ_AGENT =
  ' The Editor answers about a project once its own page has been opened on it, and never takes a home folder or a whole '
  + 'disk as a project.'
const STRANGER = 'That was not asked by this app’s own page.'

/** Which project a folder is, as the host has it. `setHostResolve` is for tests. */
let hostResolve: Resolve = resolveProject
export function setHostResolve(resolve: Resolve | null): void {
  hostResolve = resolve ?? resolveProject
}

/** The page's project: the host's answer, then the fence's. A sentence when either says no. */
async function pageRoot(named: string): Promise<{ ok: true; root: string } | { ok: false; reply: Reply }> {
  if (!named) return { ok: false, reply: bad(NO_ROOT_PAGE) }
  const project = await hostResolve(named)
  if (!project.ok) return { ok: false, reply: bad(project.reason === 'moved' ? project.why : NOT_A_PROJECT_PAGE) }
  /* The path the host gave back, never the one that was named: after a followed move they differ. */
  const root = rootOf(project.path, 'page')
  if (!root) return { ok: false, reply: bad(NOT_A_PROJECT_PAGE) }
  return { ok: true, root }
}

/**
 * The page's stream: told when the open file changed on disk, so it never asks on a clock
 * (`live.ts`). The same ticket and the same checks as `/api/stamp` before anything is watched.
 */
export const stream = makeStream(
  (ticket) => ticket === TICKET,
  async (projectPath, path) => {
    const project = await pageRoot(str(projectPath, MAX_PATH))
    if (!project.ok) return null
    const where = locate(project.root, str(path, MAX_PATH), 'page')
    return where.ok ? where.real : null
  },
)

/* ------------------------------------------------------------------ *
 * The MCP door: read-only
 * ------------------------------------------------------------------ */

/** What an agent is told when it asks this door to change anything. */
export const READ_ONLY_DOOR =
  'The Editor’s agent door only reads. It cannot save, write, revert or reload a file. Edit files with your own tools; '
  + 'the person saves their own edits in the Editor.'

function tools() {
  return [
    {
      name: 'editing',
      description:
        'Which file the person has open in the Editor container for a project, whether they have unsaved changes, and '
        + 'why it is read-only when it is. With text: true, also the unsaved text in the editor. This is NOT the tool '
        + 'for reading files (use your own reader) and there is no tool here for writing them: this door only reads.',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'The absolute directory of the project. Required.' },
          text: { type: 'boolean', description: 'Also return the unsaved text in the editor, when there is some.' },
        },
        required: ['project'],
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
  ]
}

async function call(name: string, args: Record<string, unknown>): Promise<string> {
  if (name !== 'editing') throw new Error(`There is no tool "${name.slice(0, 60)}" here. ${READ_ONLY_DOOR}`)
  const named = str(doorContext(args).project, MAX_PATH)
  if (!named) throw new Error(DOOR_PROJECT_SAYS.unnamed)
  const project = await hostResolve(named)
  if (!project.ok) throw new Error(project.why)
  const root = rootOf(project.path)
  if (!root) throw new Error(DOOR_PROJECT_SAYS.notProject(project.path) + NOT_READ_AGENT)
  const answer = describe(editingIn(root), args.text === true)
  return project.movedFrom ? `${answer}\n\n${DOOR_PROJECT_SAYS.followed(project.movedFrom, project.path)}` : answer
}

interface Rpc {
  id?: number | string
  method?: string
  params?: { name?: string; arguments?: Record<string, unknown> }
}

async function mcp(rpc: Rpc): Promise<Reply> {
  const reply = (result: unknown) => ok({ jsonrpc: '2.0', id: rpc.id ?? null, result })
  const text = (s: string, isError = false) => reply({ content: [{ type: 'text', text: s }], ...(isError ? { isError } : {}) })

  if (rpc.method === 'initialize') {
    return reply({
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: ID, version: VERSION },
      instructions:
        'The container a person edits a file in, on a canvas. This door only reads: it says which file is open and '
        + 'whether the person has unsaved changes. It cannot save or write; edit files with your own tools.',
    })
  }
  if (typeof rpc.method === 'string' && rpc.method.startsWith('notifications/')) return { status: 202, body: null }
  if (rpc.method === 'tools/list') return reply({ tools: tools() })
  if (rpc.method === 'tools/call') {
    try {
      return text(await call(String(rpc.params?.name ?? ''), rpc.params?.arguments ?? {}))
    } catch (e) {
      return text(e instanceof Error ? e.message : String(e), true)
    }
  }
  return { status: 404, body: { jsonrpc: '2.0', id: rpc.id ?? null, error: { code: -32601, message: String(rpc.method) } } }
}

/* ------------------------------------------------------------------ *
 * The doors
 * ------------------------------------------------------------------ */

export async function answer(
  method: string,
  path: string,
  query: URLSearchParams,
  body: Record<string, unknown> | null,
  ticket: string | null,
): Promise<Reply | null> {
  if (path === '/healthz') {
    const configured = configuredRoots().length
    return ok({
      ok: true,
      id: ID,
      version: VERSION,
      roots: configured === 0 ? 'the projects this app’s own page has been opened on' : `${configured} configured`,
      ceiling: bytes(MAX_BYTES),
      writes:
        'the open file, on an explicit save from this app’s own page, atomically, and only when unchanged on disk since '
        + 'the edit began; never under .kehikot/',
      agents: 'read-only',
    })
  }

  if (path === '/mcp') {
    if (method !== 'POST') return bad('the MCP door takes POST', 405)
    if (!body || typeof body.method !== 'string') {
      return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'not a request' } } }
    }
    return mcp(body as Rpc)
  }

  if (!path.startsWith('/api/')) return null

  /* Every /api route is the page's. Marked as a ticket refusal, so a page older than this server reloads. */
  const stranger = refuseTicket(ticket, TICKET, STRANGER)
  if (stranger) return stranger

  if (path === '/api/open' && method === 'GET') {
    const project = await pageRoot(str(query.get('projectPath'), MAX_PATH))
    if (!project.ok) return project.reply
    const at = str(query.get('path'), MAX_PATH)
    if (!at) return bad('Nothing named a file to open.')
    const opened = open(project.root, at, 'page')
    if (opened.kind === 'refused') return bad(opened.error, 404)
    return ok({ ok: true, root: project.root, ...opened })
  }

  if (path === '/api/stamp' && method === 'GET') {
    const project = await pageRoot(str(query.get('projectPath'), MAX_PATH))
    if (!project.ok) return project.reply
    const stamp = stampOf(project.root, str(query.get('path'), MAX_PATH))
    return ok(stamp.ok ? { ok: true, version: stamp.version } : { ok: true, version: null, gone: stamp.error })
  }

  if (path === '/api/save' && method === 'POST') {
    if (!body) return bad('That was not a request.')
    const project = await pageRoot(str(body.projectPath, MAX_PATH))
    if (!project.ok) return project.reply
    const at = str(body.path, MAX_PATH)
    if (!at) return bad('Nothing named a file to save.')
    const saved = save(project.root, at, body.text, body.base)
    if (saved.kind === 'refused') return bad(saved.error, 409)
    if (saved.kind === 'conflict') return { status: 409, body: { ok: false, ...saved } }
    /* A page following this file (another window, or this one) is told at once. */
    const where = locate(project.root, at, 'page')
    if (where.ok) told(where.real)
    return ok({ ok: true, ...saved })
  }

  if (path === '/api/editing' && method === 'POST') {
    if (!body) return bad('That was not a request.')
    const project = await pageRoot(str(body.projectPath, MAX_PATH))
    if (!project.ok) return project.reply
    const refused = report(project.root, body)
    return refused ? bad(refused, 413) : ok({ ok: true })
  }

  return bad('not here', 404)
}

export { MANIFEST }
