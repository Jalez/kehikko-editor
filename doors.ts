import { KEHIKOT_DIR, doorContext } from 'kehikot-module-protocol'
import { establishBuild, mintTicket, refuseTicket, type Reply } from 'kehikot-module-protocol/serve'

import { ID, MANIFEST, VERSION } from './manifest.ts'
import { FILE, readValue, writeValue } from './store.ts'

/**
 * Every door but the page, as one pure function: `answer` takes a request and
 * returns a status and a body, or `null` for "not ours, let Vite have it".
 * `doors()` in vite.config.ts is the only thing that touches a socket, which is what lets
 * the tests call this directly.
 */

/**
 * The ticket a page write has to carry.
 *
 * Minted per process and printed into `/app` by `doors()` in vite.config.ts,
 * so only this app's own page holds it. Loopback is a fence around the
 * machine, not around the programs on it: without this, anything that found
 * the port could write. Reads are ungated, and `/mcp` is ungated because an
 * agent has no page to have been handed a ticket by.
 */
export const TICKET = mintTicket()

/**
 * What this process is built from, and when it started. `doors()` says it in the manifest, at
 * `/healthz`, in the page and on every answer, so a page — and a host — can tell when the server
 * behind a page is no longer the one that served it.
 */
export const BUILD = establishBuild({ version: VERSION, dir: import.meta.dirname })

/** Writes are bounded; nothing this app keeps is anywhere near this size. */
export const MAX_VALUE_BYTES = 100_000

const ok = (body: unknown): Reply => ({ status: 200, body })
const bad = (why: string, status = 400): Reply => ({ status, body: { ok: false, error: why } })

/* ------------------------------------------------------------------ *
 * The MCP door, for agents. One example tool; add yours beside it.
 * ------------------------------------------------------------------ */

function tools() {
  return [
    {
      name: 'read_value',
      description:
        'What Editor is holding for a project. Give the absolute project directory as project; the '
        + `value lives at <project>/${KEHIKOT_DIR}/editor/${FILE}.json.`,
      /* The context arguments are spelled `project` and `epic` at every module's door (`DOOR_ARGUMENTS`). */
      inputSchema: {
        type: 'object',
        properties: { project: { type: 'string', description: 'The absolute directory of the project.' } },
        required: ['project'],
      },
      /* Said for every tool: a caller that runs tools unasked can tell one that only reads from
         one that writes. A tool that writes says `readOnlyHint: false`, and `destructiveHint:
         false` when it deletes and overwrites nothing. */
      annotations: { readOnlyHint: true },
    },
  ]
}

function call(name: string, args: Record<string, unknown>): string {
  if (name === 'read_value') {
    const read = readValue(doorContext(args).project)
    if (!read.ok) throw new Error(read.error)
    return read.value === null ? 'Nothing is stored for that project yet.' : JSON.stringify(read.value, null, 2)
  }
  throw new Error(`no tool "${name.slice(0, 60)}" here`)
}

interface Rpc {
  id?: number | string
  method?: string
  params?: { name?: string; arguments?: Record<string, unknown> }
}

function mcp(rpc: Rpc): Reply {
  const reply = (result: unknown) => ok({ jsonrpc: '2.0', id: rpc.id ?? null, result })
  const text = (s: string, isError = false) => reply({ content: [{ type: 'text', text: s }], ...(isError ? { isError } : {}) })

  if (rpc.method === 'initialize') {
    return reply({
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: ID, version: VERSION },
      instructions: MANIFEST.mcp?.about ?? '',
    })
  }
  /* A notification carries no id and is answered with nothing. */
  if (typeof rpc.method === 'string' && rpc.method.startsWith('notifications/')) return { status: 202, body: null }
  if (rpc.method === 'tools/list') return reply({ tools: tools() })
  if (rpc.method === 'tools/call') {
    try {
      return text(call(String(rpc.params?.name ?? ''), rpc.params?.arguments ?? {}))
    } catch (e) {
      /* A refusal is an answer the agent reads, not a transport failure it retries. */
      return text(e instanceof Error ? e.message : String(e), true)
    }
  }
  return { status: 404, body: { jsonrpc: '2.0', id: rpc.id ?? null, error: { code: -32601, message: String(rpc.method) } } }
}

/* ------------------------------------------------------------------ *
 * The doors.
 * ------------------------------------------------------------------ */

export function answer(
  method: string,
  path: string,
  query: URLSearchParams,
  body: Record<string, unknown> | null,
  ticket: string | null,
): Reply | null {
  if (path === '/healthz') {
    return ok({ ok: true, id: ID, version: VERSION, where: `<project>/${KEHIKOT_DIR}/editor/${FILE}.json` })
  }

  if (path === '/mcp') {
    if (method !== 'POST') return bad('the MCP door takes POST', 405)
    if (!body || typeof body.method !== 'string') {
      return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'not a request' } } }
    }
    return mcp(body as Rpc)
  }

  if (path === '/api/value' && method === 'GET') {
    const read = readValue(query.get('projectPath'))
    return read.ok ? ok({ ok: true, value: read.value }) : bad(read.error)
  }

  if (path === '/api/value' && method === 'POST') {
    const refused = refuseTicket(ticket, TICKET)
    if (refused) return refused
    if (!body) return bad('that was not a request')
    if (JSON.stringify(body.value ?? null).length > MAX_VALUE_BYTES) return bad('that value is too large to keep', 413)
    const projectPath = typeof body.projectPath === 'string' ? body.projectPath : null
    const written = writeValue(projectPath, body.value ?? null)
    return written.ok ? ok({ ok: true }) : bad(written.error)
  }

  /* An unknown path under /api/ is ours to refuse, not Vite's to serve as a file. */
  if (path.startsWith('/api/')) return bad('not here', 404)
  return null
}

export { MANIFEST }
