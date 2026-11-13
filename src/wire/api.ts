import { ask, subscribe, ticket, type Asked } from 'kehikot-module-protocol/client'

import type { OpenedFile } from '@/edit/state'

/**
 * This module's own `/api`, as the page calls it. Every call carries the ticket
 * printed into this page (`ticket: true`), reads too: what is read here is a
 * file's contents. `ask` never throws; each answer is one typed result.
 */

export type Opened = OpenedFile & { root: string }

export type SaveAnswer =
  | { kind: 'saved'; version: string; unchanged: boolean }
  | { kind: 'conflict'; version: string; text: string | null; said: string }
  | { kind: 'refused'; said: string }
  | { kind: 'down'; said: string }

export interface FileHit {
  relative: string
  score: number
  hits: number[]
}

export interface SearchQuery {
  query: string
  caseSensitive: boolean
  wholeWord: boolean
  regex: boolean
  include: string[]
  exclude: string[]
}

export interface SearchMatch {
  line: number
  column: number
  length: number
  preview: string
  previewStart: number
}

export interface SearchAnswer {
  files: { relative: string; count: number; matches: SearchMatch[] }[]
  total: number
  truncated: boolean
  timedOut: boolean
  cancelled?: boolean
  error?: string
}

export interface Target {
  relative: string
  line: number
  column: number
  preview?: string
  kind?: string
}

export interface Definition {
  targets: Target[]
  via: string | null
  said: string | null
}

export interface SymbolHit {
  name: string
  kind: string
  line: number
  column: number
  depth?: number
  container?: string
  relative?: string
}

/** An agent's order, as the server hands it to the page (`file/tabs.ts`). */
export type Order =
  | { id: string; kind: 'open'; files: { relative: string; line?: number; column?: number; endLine?: number; endColumn?: number; preview?: boolean }[]; focus: string | null; kehikko: string | null }
  | { id: string; kind: 'focus'; relative: string; kehikko: string | null }
  | { id: string; kind: 'close'; paths: string[]; kehikko: string | null }

export interface OrderDone {
  opened?: string[]
  background?: boolean
  focused?: string | null
  closed?: string[]
  kept?: { relative: string; why: string }[]
  refused?: { relative: string; why: string }[]
}

export interface Api {
  /** Quick open: the project's files ranked for a query. */
  files?(projectPath: string, query: string): Promise<{ files: FileHit[]; truncated: boolean } | null>
  /** Search in project. A newer search with the same id cancels the older one on the server. */
  search?(projectPath: string, searchId: string, query: SearchQuery): Promise<SearchAnswer | { error: string }>
  definition?(projectPath: string, path: string, offset: number, text: string | null): Promise<Definition | { error: string }>
  outline?(projectPath: string, path: string, text: string | null): Promise<SymbolHit[] | null>
  symbols?(projectPath: string, query: string): Promise<SymbolHit[] | null>
  /** The person's keyboard shortcuts text (a machine setting), and saving it. */
  keybindings?(): Promise<{ text: string; problem?: string } | null>
  saveKeybindings?(text: string): Promise<string | true>
  /** Hear an agent's orders for this project; returns the function that stops. */
  orders?(projectPath: string, onOrders: (orders: Order[]) => void): () => void
  /** The orders held while no page was open. */
  heldOrders?(projectPath: string): Promise<Order[]>
  ordersDone?(id: string, done: OrderDone): Promise<void>
  open(projectPath: string, path: string, signal?: AbortSignal): Promise<Asked<Opened>>
  stamp(projectPath: string, path: string): Promise<{ version: string | null; gone?: string } | null>
  save(projectPath: string, path: string, text: string, base: string): Promise<SaveAnswer>
  editing(projectPath: string, report: Record<string, unknown>): Promise<void>
  /**
   * Hear when the open file may have changed on disk: once as the stream opens (and again each time
   * it reopens, after a drop or when the page is shown again), then whenever the server sees the
   * file written. Never on a clock, and nothing while the page is hidden. Returns the function that
   * stops it. The ticket rides in the query: an `EventSource` sends no headers.
   */
  changes(projectPath: string, path: string, onChange: () => void): () => void
}

export const api: Api = {
  open(projectPath, path, signal) {
    return ask<Opened>('./api/open', { query: { projectPath, path }, ticket: true, ...(signal ? { signal } : {}) })
  },
  async stamp(projectPath, path) {
    const asked = await ask<{ version: string | null; gone?: string }>('./api/stamp', { query: { projectPath, path }, ticket: true })
    return asked.ok ? asked.body : null
  },
  async save(projectPath, path, text, base) {
    const asked = await ask<{ version: string; unchanged: boolean }>('./api/save', { body: { projectPath, path, text, base } })
    if (asked.ok) return { kind: 'saved', version: asked.body.version, unchanged: asked.body.unchanged }
    if (asked.kind === 'down' || asked.kind === 'stale') return { kind: 'down', said: asked.error }
    const body = asked.body as { kind?: string; version?: string; text?: string | null; error?: string } | null
    if (body?.kind === 'conflict' && typeof body.version === 'string') {
      return { kind: 'conflict', version: body.version, text: typeof body.text === 'string' ? body.text : null, said: body.error ?? asked.error }
    }
    return { kind: 'refused', said: asked.error }
  },
  changes(projectPath, path, onChange) {
    return subscribe('./api/stamp/events', () => onChange(), { query: { projectPath, path, ticket: ticket() }, probe: true })
  },
  async editing(projectPath, report) {
    await ask('./api/editing', { body: { projectPath, ...report } })
  },
  async files(projectPath, query) {
    const asked = await ask<{ files: FileHit[]; truncated: boolean }>('./api/files', { query: { projectPath, query, limit: '50' }, ticket: true })
    return asked.ok ? { files: asked.body.files ?? [], truncated: Boolean(asked.body.truncated) } : null
  },
  async search(projectPath, searchId, query) {
    const asked = await ask<SearchAnswer>('./api/search', { body: { projectPath, searchId, ...query } })
    return asked.ok ? asked.body : { error: asked.error }
  },
  async definition(projectPath, path, offset, text) {
    const asked = await ask<Definition>('./api/definition', { body: { projectPath, path, offset, ...(text !== null ? { text } : {}) } })
    return asked.ok ? { targets: asked.body.targets ?? [], via: asked.body.via ?? null, said: asked.body.said ?? null } : { error: asked.error }
  },
  async outline(projectPath, path, text) {
    const asked = await ask<{ symbols: SymbolHit[] }>('./api/outline', { body: { projectPath, path, ...(text !== null ? { text } : {}) } })
    return asked.ok ? (asked.body.symbols ?? []) : null
  },
  async symbols(projectPath, query) {
    const asked = await ask<{ symbols: SymbolHit[] }>('./api/symbols', { query: { projectPath, query }, ticket: true })
    return asked.ok ? (asked.body.symbols ?? []) : null
  },
  async keybindings() {
    const asked = await ask<{ values?: Record<string, unknown>; problem?: string }>('./api/kehikot/settings', { ticket: true })
    if (!asked.ok) return null
    const text = asked.body.values?.keybindings
    return { text: typeof text === 'string' ? text : '', ...(asked.body.problem ? { problem: asked.body.problem } : {}) }
  },
  async saveKeybindings(text) {
    const asked = await ask<{ outcome?: string; why?: string }>('./api/kehikot/settings', { body: { key: 'keybindings', value: text, by: 'person' } })
    if (!asked.ok) return asked.error
    return asked.body.outcome === 'saved' ? true : (asked.body.why ?? 'Your keyboard shortcuts were not saved.')
  },
  orders(projectPath, onOrders) {
    return subscribe<{ orders?: Order[] }>('./api/orders/events', (event) => {
      if (event && Array.isArray(event.orders)) onOrders(event.orders)
    }, { query: { projectPath, ticket: ticket() }, whileHidden: true })
  },
  async heldOrders(projectPath) {
    const asked = await ask<{ orders: Order[] }>('./api/orders/held', { body: { projectPath } })
    return asked.ok && Array.isArray(asked.body.orders) ? asked.body.orders : []
  },
  async ordersDone(id, done) {
    await ask('./api/orders/done', { body: { id, done } })
  },
}
