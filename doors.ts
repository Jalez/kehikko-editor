import { DOOR_PROJECT_SAYS, doorContext } from 'kehikot-module-protocol'
import { establishBuild, mintTicket, refuseTicket, settingsDoor, type Reply } from 'kehikot-module-protocol/serve'

import { configuredRoots, rootOf } from './file/confine.ts'
import { lookForDocument } from './file/document.ts'
import { lookForFolders } from './file/folders.ts'
import { describe, editingIn, report } from './file/editing.ts'
import { locate, open, stampOf } from './file/open.ts'
import { SETTINGS, describeCommands, readKeybindings, writeKeybindings, KEYBINDINGS_KEY } from './file/keybindings.ts'
import { save } from './file/save.ts'
import { ORDER_FILES, describeTabs, done as orderDone, give, notePage, orderId, reportTabs, takeHeld, type OpenFile, type Order, type Delivered } from './file/tabs.ts'
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

/** The person's keyboard shortcuts, as a machine setting (`file/keybindings.ts`). */
const settings = settingsDoor({
  module: ID,
  fields: SETTINGS,
  read: () => {
    const read = readKeybindings()
    return { values: { [KEYBINDINGS_KEY]: read.text }, ...(read.problem ? { problem: read.problem } : {}) }
  },
  write: (_project, key, value) => (key === KEYBINDINGS_KEY ? writeKeybindings(value) : 'There is no such setting.'),
  ticket: TICKET,
})

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

/** What an agent is told when it asks this door to write. */
export const READ_ONLY_DOOR =
  'The Editor’s agent door never writes a file. It cannot save, revert or reload one, and it never discards the person’s '
  + 'edits: it opens files as tabs, focuses a tab and closes saved tabs. Edit files with your own tools; the person saves '
  + 'their own edits in the Editor.'

const PROJECT_ARG = { type: 'string', description: 'The absolute directory of the project. Required.' }
const KEHIKKO_ARG = {
  type: 'string',
  description: 'Which kehikko’s Editor to act on, by its key or name, when the project has Editor containers on several. Absent: every Editor page open on the project.',
}
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
const ACT = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }

function tools() {
  return [
    {
      name: 'editing',
      description:
        'Which file the person has open in the Editor container for a project, whether they have unsaved changes, and '
        + 'why it is read-only when it is. With text: true, also the unsaved text in the active tab. This is NOT the tool '
        + 'for reading files (use your own reader) and there is no tool here for writing them.',
      inputSchema: {
        type: 'object',
        properties: { project: PROJECT_ARG, text: { type: 'boolean', description: 'Also return the unsaved text in the editor, when there is some.' } },
        required: ['project'],
      },
      annotations: READ,
    },
    {
      name: 'tabs',
      description: 'The tabs open in the Editor for a project: which is active, which have unsaved changes, which are previews and which an agent opened.',
      inputSchema: { type: 'object', properties: { project: PROJECT_ARG, kehikko: KEHIKKO_ARG }, required: ['project'] },
      annotations: READ,
    },
    {
      name: 'open_files',
      description:
        `Open one or more files of the project as tabs in the Editor (at most ${ORDER_FILES}), each optionally at a line `
        + 'and column, or with a range selected. They open kept (not as previews, unless preview: true), marked as opened '
        + 'by an agent, and in the background: the person keeps the tab they are on. focus names one of the files to make '
        + 'active, which is done only when the active tab has no unsaved changes. With no Editor open on the project, the '
        + 'files are held and open when it next opens. Never discards an edit; a file outside the project, missing, '
        + 'binary or one agents may not read is refused in words.',
      inputSchema: {
        type: 'object',
        properties: {
          project: PROJECT_ARG,
          files: {
            type: 'array',
            minItems: 1,
            maxItems: ORDER_FILES,
            items: {
              type: 'object',
              properties: {
                path: { type: 'string', description: 'The file: absolute, or relative to the project.' },
                line: { type: 'integer', minimum: 1, description: 'The line to show, from 1.' },
                column: { type: 'integer', minimum: 1, description: 'The column on that line, from 1.' },
                endLine: { type: 'integer', minimum: 1, description: 'With endColumn: select from line/column to here.' },
                endColumn: { type: 'integer', minimum: 1 },
                preview: { type: 'boolean', description: 'Open as a preview, replaced by the next preview. Default false.' },
              },
              required: ['path'],
            },
          },
          focus: { type: 'string', description: 'One of the files to make the active tab (only when the active tab is unedited).' },
          kehikko: KEHIKKO_ARG,
        },
        required: ['project', 'files'],
      },
      annotations: ACT,
    },
    {
      name: 'focus_tab',
      description: 'Make an open tab the active one. Done only when the active tab has no unsaved changes; otherwise said.',
      inputSchema: { type: 'object', properties: { project: PROJECT_ARG, path: { type: 'string' }, kehikko: KEHIKKO_ARG }, required: ['project', 'path'] },
      annotations: ACT,
    },
    {
      name: 'close_tabs',
      description: 'Close tabs that are saved. A tab with unsaved changes is never closed: it is named in the answer, and stays.',
      inputSchema: {
        type: 'object',
        properties: { project: PROJECT_ARG, paths: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 60 }, kehikko: KEHIKKO_ARG },
        required: ['project', 'paths'],
      },
      annotations: ACT,
    },
    {
      name: 'commands',
      description: 'The Editor’s commands (go to definition, go to file, search in project, close tab, …) with the keys that run them on this computer. Read-only.',
      inputSchema: { type: 'object', properties: {} },
      annotations: READ,
    },
  ]
}

async function projectRoot(args: Record<string, unknown>): Promise<{ root: string; moved: string | null }> {
  const named = str(doorContext(args).project, MAX_PATH)
  if (!named) throw new Error(DOOR_PROJECT_SAYS.unnamed)
  const project = await hostResolve(named)
  if (!project.ok) throw new Error(project.why)
  const root = rootOf(project.path)
  if (!root) throw new Error(DOOR_PROJECT_SAYS.notProject(project.path) + NOT_READ_AGENT)
  return { root, moved: project.movedFrom ? DOOR_PROJECT_SAYS.followed(project.movedFrom, project.path) : null }
}

const positive = (value: unknown) => (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 10_000_000 ? value : undefined)

/** A file an agent named, checked as a file the agent may open: inside, there, text, not withheld. */
function agentFile(root: string, raw: unknown): { ok: true; relative: string } | { ok: false; why: string } {
  const at = str(raw, MAX_PATH)
  if (!at) return { ok: false, why: 'A file was not named.' }
  const opened = open(root, at, 'agent')
  if (opened.kind === 'refused') return { ok: false, why: `${at.slice(0, 200)}: ${opened.error}` }
  return { ok: true, relative: opened.relative }
}

const kehikkoOf = (args: Record<string, unknown>) => str(args.kehikko, 128) || null

function saidDelivered(delivered: Delivered, what: string): string {
  if (delivered.kind === 'held') return `No Editor page is open on this project right now. ${what} held and open as tabs when the Editor is next opened (while it keeps running).`
  if (delivered.kind === 'no-page') return 'No Editor page is open on this project right now, so there are no tabs to act on.'
  if (delivered.kind === 'sent') return `Sent to the Editor page open on this project; it did not say back in time what it did. Call tabs to see.`
  return ''
}

async function call(name: string, args: Record<string, unknown>): Promise<string> {
  if (name === 'commands') return describeCommands()
  if (!['editing', 'tabs', 'open_files', 'focus_tab', 'close_tabs'].includes(name)) throw new Error(`There is no tool "${name.slice(0, 60)}" here. ${READ_ONLY_DOOR}`)
  const { root, moved } = await projectRoot(args)
  const withMove = (answer: string) => (moved ? `${answer}\n\n${moved}` : answer)
  if (name === 'editing') return withMove(describe(editingIn(root), args.text === true))
  if (name === 'tabs') return withMove(describeTabs(root, kehikkoOf(args)))

  if (name === 'open_files') {
    const raw = Array.isArray(args.files) ? args.files : []
    if (!raw.length) throw new Error('Name at least one file: files: [{ path }].')
    if (raw.length > ORDER_FILES) throw new Error(`At most ${ORDER_FILES} files at once.`)
    const files: OpenFile[] = []
    const refused: string[] = []
    for (const one of raw) {
      const entry = (one && typeof one === 'object' ? one : { path: one }) as Record<string, unknown>
      const checked = agentFile(root, entry.path)
      if (!checked.ok) {
        refused.push(checked.why)
        continue
      }
      files.push({
        relative: checked.relative,
        ...(positive(entry.line) ? { line: positive(entry.line) } : {}),
        ...(positive(entry.column) ? { column: positive(entry.column) } : {}),
        ...(positive(entry.endLine) ? { endLine: positive(entry.endLine) } : {}),
        ...(positive(entry.endColumn) ? { endColumn: positive(entry.endColumn) } : {}),
        ...(entry.preview === true ? { preview: true } : {}),
      })
    }
    const refusedSaid = refused.length ? `\nRefused:\n${refused.map((one) => `- ${one}`).join('\n')}` : ''
    if (!files.length) throw new Error(`Nothing was opened.${refusedSaid}`)
    let focus: string | null = null
    if (args.focus !== undefined) {
      const checked = agentFile(root, args.focus)
      focus = checked.ok && files.some((one) => one.relative === checked.relative) ? checked.relative : null
    }
    const order: Order = { id: orderId(), kind: 'open', files, focus, kehikko: kehikkoOf(args) }
    const delivered = await give(root, order)
    if (delivered.kind !== 'done') return withMove(`${saidDelivered(delivered, files.length === 1 ? `${files[0]!.relative} is` : `${files.length} files are`)}${refusedSaid}`)
    const did = delivered.done
    const lines = [
      did.opened?.length ? `Opened as tabs: ${did.opened.join(', ')}.` : 'Nothing new was opened.',
      did.focused ? `${did.focused} is the active tab.` : did.background ? 'They opened in the background: the person’s active tab has unsaved changes, so it stays in front.' : 'They opened in the background; the person’s active tab stays in front.',
      ...(did.refused ?? []).map((one) => `Not opened: ${one.relative} — ${one.why}`),
    ]
    return withMove(lines.join('\n') + refusedSaid)
  }

  if (name === 'focus_tab') {
    const checked = agentFile(root, args.path)
    if (!checked.ok) throw new Error(checked.why)
    const delivered = await give(root, { id: orderId(), kind: 'focus', relative: checked.relative, kehikko: kehikkoOf(args) })
    if (delivered.kind !== 'done') return withMove(saidDelivered(delivered, ''))
    const did = delivered.done
    if (did.focused) return withMove(`${did.focused} is the active tab.`)
    return withMove((did.refused ?? []).map((one) => `${one.relative}: ${one.why}`).join('\n') || 'Nothing was focused.')
  }

  /* close_tabs */
  const raw = Array.isArray(args.paths) ? args.paths.slice(0, 60) : []
  if (!raw.length) throw new Error('Name at least one tab: paths: ["src/a.ts"].')
  const paths: string[] = []
  for (const one of raw) {
    const at = str(one, MAX_PATH)
    const where = at ? locate(root, at, 'agent') : null
    if (where?.ok) paths.push(where.relative)
  }
  if (!paths.length) throw new Error('None of those is a file of this project that agents may name.')
  const delivered = await give(root, { id: orderId(), kind: 'close', paths, kehikko: kehikkoOf(args) })
  if (delivered.kind !== 'done') return withMove(saidDelivered(delivered, ''))
  const did = delivered.done
  return withMove(
    [
      did.closed?.length ? `Closed: ${did.closed.join(', ')}.` : 'Nothing was closed.',
      ...(did.kept ?? []).map((one) => `Kept open: ${one.relative} — ${one.why}`),
    ].join('\n'),
  )
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
        'The container a person edits files in, as tabs, on a canvas. This door says which tabs are open and which have '
        + 'unsaved changes, opens files as tabs (open_files), focuses or closes saved tabs, and lists the commands and their '
        + 'keys. It never writes a file and never discards an edit; edit files with your own tools.',
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

  /* The settings door (2.15.0): the host's Settings, and this page with its ticket, read and change the person's keys. */
  const settingsSaid = await settings(method, path, query, body, ticket)
  if (settingsSaid) return settingsSaid

  /* Every /api route is the page's. Marked as a ticket refusal, so a page older than this server reloads. */
  const stranger = refuseTicket(ticket, TICKET, STRANGER)
  if (stranger) return stranger

  /* The orders held for a project while no page was open, handed to the page that opened (`file/tabs.ts`). */
  if (path === '/api/orders/held' && method === 'POST') {
    if (!body) return bad('That was not a request.')
    const project = await pageRoot(str(body.projectPath, MAX_PATH))
    if (!project.ok) return project.reply
    notePage(project.root, str(body.projectPath, MAX_PATH))
    return ok({ ok: true, orders: takeHeld(project.root) })
  }

  /* What a page did with an agent's order (`file/tabs.ts`). */
  if (path === '/api/orders/done' && method === 'POST') {
    if (!body || typeof body.id !== 'string' || body.id.length > 64) return bad('That was not a request.')
    orderDone(body.id, (body.done && typeof body.done === 'object' ? body.done : {}) as never)
    return ok({ ok: true })
  }

  if (path === '/api/open' && method === 'GET') {
    const project = await pageRoot(str(query.get('projectPath'), MAX_PATH))
    if (!project.ok) return project.reply
    const at = str(query.get('path'), MAX_PATH)
    if (!at) return bad('Nothing named a file to open.')
    /* Whose folders are read-only in whose name: asked of the host, cached, never thrown. */
    await Promise.all([lookForDocument(ID), lookForFolders(ID)])
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
    await Promise.all([lookForDocument(ID), lookForFolders(ID)])
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
    notePage(project.root, str(body.projectPath, MAX_PATH))
    const refused = report(project.root, body) ?? reportTabs(project.root, body)
    return refused ? bad(refused, 413) : ok({ ok: true })
  }

  return bad('not here', 404)
}

export { MANIFEST }
