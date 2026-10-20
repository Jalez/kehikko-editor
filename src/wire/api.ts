import { ask, type Asked } from 'kehikot-module-protocol/client'

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

export interface Api {
  open(projectPath: string, path: string, signal?: AbortSignal): Promise<Asked<Opened>>
  stamp(projectPath: string, path: string): Promise<{ version: string | null; gone?: string } | null>
  save(projectPath: string, path: string, text: string, base: string): Promise<SaveAnswer>
  editing(projectPath: string, report: Record<string, unknown>): Promise<void>
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
  async editing(projectPath, report) {
    await ask('./api/editing', { body: { projectPath, ...report } })
  },
}
