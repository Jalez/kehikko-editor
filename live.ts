import { createHash } from 'node:crypto'
import { existsSync, watch, type FSWatcher } from 'node:fs'
import { basename, dirname } from 'node:path'

import { events, publish, watching } from 'kehikot-module-protocol/serve'

/**
 * Telling the page that the file it has open changed on disk, over one held stream: the page never
 * asks on a clock (protocol 2.32.0, `events`/`subscribe`). What travels is that there IS news; the
 * page asks `/api/stamp` again, the door it already asks, and the version there says whether it
 * really changed.
 *
 * News is published where the change happens: the Editor's own save (`saved`, from `doors.ts`), and a
 * watcher over the open file's folder while a page follows it, for every other program that writes
 * the file. The folder rather than the file, because a save is atomic — a new file renamed over the
 * old one — and a watcher on the file would be left watching the one that was replaced.
 *
 * The stream is the page's, like every `/api` route: it carries the page's ticket, in the query,
 * because an `EventSource` sends no headers. A file is only watched once the project has passed the
 * host and the fence and the path has passed `locate` — the same checks `/api/stamp` makes.
 */

export const EVENTS_PATH = '/api/stamp/events'

/** The news itself. The page asks the stamp on any event; the first is sent as a stream opens. */
export const NEWS = { changed: true } as const

/** One topic per project and file as the page named them; hashed, because a topic is at most 512 characters. */
export const topicOf = (projectPath: string, path: string): string =>
  `stamp:${createHash('sha256').update(`${projectPath}\0${path}`).digest('hex')}`

/* A save writes, renames and may chmod: one piece of news. */
const SETTLE_MS = 50
const settling = new Map<string, ReturnType<typeof setTimeout>>()

function changed(topic: string): void {
  if (settling.has(topic) || watching(topic) === 0) return
  settling.set(
    topic,
    setTimeout(() => {
      settling.delete(topic)
      publish(topic, NEWS)
    }, SETTLE_MS),
  )
}

interface Watched {
  watcher: FSWatcher
  /** The real path of the file, once it passed the fence. */
  real: string
}

const watched = new Map<string, Watched>()

/** Say that the file at `real` changed (the Editor saved it). Nothing is sent when no page follows it. */
export function saved(real: string): void {
  for (const [topic, one] of watched) if (one.real === real) changed(topic)
}

function watchFile(topic: string, real: string): void {
  if (watched.has(topic)) return
  const folder = dirname(real)
  const name = basename(real)
  if (!existsSync(folder)) return
  try {
    const watcher = watch(folder, { persistent: false }, (_event, changedName) => {
      if (watching(topic) === 0) {
        watcher.close()
        watched.delete(topic)
        return
      }
      /* Some platforms name nothing; then any change in the folder is worth one stamp. */
      if (typeof changedName === 'string' && changedName !== name) return
      changed(topic)
    })
    watcher.on('error', () => {
      watcher.close()
      watched.delete(topic)
    })
    watched.set(topic, { watcher, real })
  } catch {
    /* A folder that cannot be watched: the Editor's own saves still publish, and the page asks on focus. */
  }
}

/** Stop every watcher (tests, and a server that stops). */
export function stopWatching(): void {
  for (const one of watched.values()) one.watcher.close()
  watched.clear()
  for (const timer of settling.values()) clearTimeout(timer)
  settling.clear()
}

/** How many files are watched, for tests. */
export const watchedCount = (): number => watched.size

/**
 * The doors' `stream` option: `/api/stamp/events?projectPath=…&path=…&ticket=…`.
 *
 * `fileOf` is the doors' own check — the host, the fence, `locate` — and answers the real path of the
 * file, or null when the page may not look at it (then nothing is watched; the stamp door says why).
 */
export const makeStream = (ticketOk: (ticket: string | null) => boolean, fileOf: (projectPath: string, path: string) => Promise<string | null>) =>
  events((path, query, ticket) => {
    if (path !== EVENTS_PATH) return null
    /* Not the page's: handed on to `answer`, which refuses it as it refuses every /api route without the ticket. */
    if (!ticketOk(ticket ?? query.get('ticket'))) return null
    const projectPath = query.get('projectPath') ?? ''
    const file = query.get('path') ?? ''
    if (!projectPath || !file) return null
    const topic = topicOf(projectPath, file)
    void fileOf(projectPath, file)
      .then((real) => {
        if (real && watching(topic) > 0) watchFile(topic, real)
      })
      .catch(() => {})
    return { topic, initial: NEWS }
  })
