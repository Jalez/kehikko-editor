import { answered, ask } from 'kehikot-module-protocol/client'

/**
 * This module's own `/api`, as the page calls it. `ask` carries the ticket on
 * a write and turns every failure into one sentence: the server stopped, the
 * server said no (in its own words), or this page is older than its server.
 */
export interface Api {
  read(projectPath: string): Promise<unknown>
  write(projectPath: string, value: unknown): Promise<void>
}

export const api: Api = {
  async read(projectPath) {
    return answered(await ask<{ value?: unknown }>('./api/value', { query: { projectPath } })).value ?? null
  },
  async write(projectPath, value) {
    answered(await ask('./api/value', { body: { projectPath, value } }))
  },
}
