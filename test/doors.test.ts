import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { WELL_KNOWN } from 'kehikot-module-protocol'

import { MANIFEST, TICKET, answer } from '../doors.ts'
import { ID } from '../manifest.ts'

const project = mkdtempSync(join(tmpdir(), 'kehikko-editor-doors-'))
afterAll(() => rmSync(project, { recursive: true, force: true }))

const none = new URLSearchParams()

function rpc(method: string, params: Record<string, unknown> = {}) {
  const reply = answer('POST', '/mcp', none, { jsonrpc: '2.0', id: 1, method, params }, null)
  return reply?.body as { result?: { tools?: { name: string }[]; content?: { text: string }[]; isError?: boolean } }
}

describe('the doors', () => {
  test('the health check says which module this is', () => {
    const reply = answer('GET', '/healthz', none, null, null)
    expect(reply?.status).toBe(200)
    expect((reply?.body as { id: string }).id).toBe(ID)
  })

  test('the manifest is served at the well-known path by the config, and is this module’s', () => {
    /* vite.config.ts answers WELL_KNOWN with MANIFEST; this pins what it sends. */
    expect(WELL_KNOWN.startsWith('/')).toBe(true)
    expect(MANIFEST.id).toBe(ID)
  })

  test('a path that is not ours is left to Vite', () => {
    expect(answer('GET', '/src/main.tsx', none, null, null)).toBeNull()
  })

  test('a write without this page’s ticket is refused, and one with it is kept', () => {
    const body = { projectPath: project, value: 'hello' }
    expect(answer('POST', '/api/value', none, body, null)?.status).toBe(403)
    /* Marked, so the page's `ask()` knows it is older than this server and reloads. */
    expect((answer('POST', '/api/value', none, body, 'old')?.body as { refused?: string }).refused).toBe('ticket')
    expect(answer('POST', '/api/value', none, body, 'not-the-ticket')?.status).toBe(403)
    expect(answer('POST', '/api/value', none, body, TICKET)?.status).toBe(200)

    const read = answer('GET', '/api/value', new URLSearchParams({ projectPath: project }), null, null)
    expect((read?.body as { value: unknown }).value).toBe('hello')
  })

  test('the MCP door lists its tool and answers it', () => {
    expect(answer('GET', '/mcp', none, null, null)?.status).toBe(405)
    expect(rpc('tools/list').result?.tools?.map((one) => one.name)).toEqual(['read_value'])
    const called = rpc('tools/call', { name: 'read_value', arguments: { project } })
    expect(called.result?.isError).toBeUndefined()
  })

  test('every tool says whether it only reads, and spells the project `project`', () => {
    const tools = rpc('tools/list').result?.tools as { name: string; annotations?: { readOnlyHint?: boolean }; inputSchema: { properties: object } }[]
    for (const tool of tools) expect(typeof tool.annotations?.readOnlyHint).toBe('boolean')
    expect(Object.keys(tools[0]!.inputSchema.properties)).toEqual(['project'])
  })
})
